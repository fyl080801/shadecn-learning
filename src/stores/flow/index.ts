import { computed, ref, shallowRef } from "vue"
import { defineStore } from "pinia"
import { ApiError, flowApi } from "@/lib/api"
import { createId } from "@/lib/id"
import {
  emptyGraph,
  type FlowDetail,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowOp,
  type FlowSummary,
  type FlowTransaction,
  type FlowTransactionKind,
  type FlowViewport
} from "@/types/flow"
import { clone } from "./commands/helpers"
import {
  applyOps as runOps,
  invertOps,
  type FlowCommandContext
} from "./registry"

// 副作用：把内置命令注册进注册表。store 静态依赖它，所以一定先跑。
import "./commands"

/**
 * 画布编辑器的状态中枢。
 *
 * 一条铁律：**所有变更都走 `apply()`**。组件不许直接改 nodes / edges ——
 * 只有经过 apply 的变更才进历史栈、才会被提交到服务端。
 *
 * 「怎么改」不写在这里：每种操作是 `commands/` 下的一条命令，
 * 通过 `registry` 按 `op.type` 查表执行，加新操作不用回来改这个文件。
 *
 * 历史栈只在内存里：刷新即清空（撤销不跨会话），但内容本身不丢，
 * 已提交的都在库里。
 */

/** 撤销栈深度上限，超出丢最旧的 */
export const HISTORY_LIMIT = 100
/** 攒够这么多条操作就立刻提交，不等防抖 */
export const FLUSH_OP_THRESHOLD = 20
/** 提交防抖窗口（毫秒） */
export const FLUSH_DEBOUNCE = 800

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict"

/**
 * 事务的唯一构造口：id 和 ts 只在这里生成。
 *
 * ts 是 UTC epoch 毫秒（`Date.now()`）—— 画布这条链路上的时间一律用数值
 * 时间戳，协同时多个客户端的操作才能排到同一条时间轴上。
 */
function newTransaction(
  label: string,
  kind: FlowTransactionKind,
  ops: FlowOp[]
): FlowTransaction {
  return { id: createId("tx"), label, kind, ts: Date.now(), ops }
}

export const useFlowStore = defineStore("flow", () => {
  // —— 状态 ——
  const meta = ref<FlowSummary | null>(null)
  const nodes = ref<FlowNode[]>([])
  const edges = ref<FlowEdge[]>([])
  const viewport = ref<FlowViewport>({ x: 0, y: 0, zoom: 1 })
  const graphMeta = ref<Record<string, unknown>>({})

  const baseRevision = ref(0)
  const undoStack = shallowRef<FlowTransaction[]>([])
  const redoStack = shallowRef<FlowTransaction[]>([])
  const pending = shallowRef<FlowTransaction[]>([])
  const saveState = ref<SaveState>("saved")
  const saveError = ref<string | null>(null)
  /** 最后一次落库的时刻（UTC 毫秒），加载时先按服务端的 updatedAt 算 */
  const lastSavedAt = ref<number | null>(null)

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const dirty = computed(() => pending.value.length > 0)

  /** 命令能改的就这三样，别的状态它们碰不到 */
  const commandContext: FlowCommandContext = { nodes, edges, graphMeta }

  function applyOps(ops: FlowOp[]) {
    runOps(commandContext, ops)
  }

  /** 打开中的事务：期间的 apply 合并成一条历史 */
  let openTx: { label: string; ops: FlowOp[] } | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null

  // —— 历史 ——

  function pushHistory(transaction: FlowTransaction) {
    const next = [...undoStack.value, transaction]
    // 超出上限丢最旧的，用户无感
    undoStack.value = next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next
    redoStack.value = []
  }

  function enqueue(transaction: FlowTransaction) {
    pending.value = [...pending.value, transaction]
    // 冲突态是粘的：继续编辑不该把它擦掉，否则自动提交又活过来，
    // 把陈旧快照一遍遍推给服务端。只有重新加载（load）能解除。
    if (saveState.value !== "conflict") saveState.value = "dirty"
    scheduleFlush()
  }

  /**
   * 唯一的写入口。
   * - 事务打开时只累积，等 commitTransaction 才进历史；
   * - 否则立刻成为一条独立的历史记录。
   */
  function apply(ops: FlowOp[], label: string) {
    if (ops.length === 0) return
    applyOps(ops)

    if (openTx) {
      openTx.ops.push(...ops)
      return
    }

    const transaction = newTransaction(label, "do", ops)
    pushHistory(transaction)
    enqueue(transaction)
  }

  /** 开一个事务：中间的 apply 合成一条撤销 */
  function beginTransaction(label: string) {
    if (openTx) return
    openTx = { label, ops: [] }
  }

  function commitTransaction() {
    const tx = openTx
    openTx = null
    if (!tx || tx.ops.length === 0) return

    const transaction = newTransaction(tx.label, "do", tx.ops)
    pushHistory(transaction)
    enqueue(transaction)
  }

  function undo() {
    const transaction = undoStack.value[undoStack.value.length - 1]
    if (!transaction) return

    const ops = invertOps(transaction.ops)
    applyOps(ops)

    undoStack.value = undoStack.value.slice(0, -1)
    redoStack.value = [...redoStack.value, transaction]

    // 撤销本身也是一条要落库的事务，日志永远只往前走
    enqueue(newTransaction(`撤销：${transaction.label}`, "undo", ops))
  }

  function redo() {
    const transaction = redoStack.value[redoStack.value.length - 1]
    if (!transaction) return

    applyOps(transaction.ops)

    redoStack.value = redoStack.value.slice(0, -1)
    undoStack.value = [...undoStack.value, transaction]

    enqueue(newTransaction(`重做：${transaction.label}`, "redo", transaction.ops))
  }

  // —— 持久化 ——

  function currentGraph(): FlowGraph {
    return {
      schemaVersion: 1,
      viewport: { ...viewport.value },
      nodes: clone(nodes.value),
      edges: clone(edges.value),
      meta: { ...graphMeta.value }
    }
  }

  function clearTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function scheduleFlush() {
    // 冲突之后不再自动提交：继续推陈旧快照只会把事情弄得更糟
    if (saveState.value === "conflict") return

    const opCount = pending.value.reduce((sum, tx) => sum + tx.ops.length, 0)
    if (opCount >= FLUSH_OP_THRESHOLD) {
      void flush()
      return
    }

    clearTimer()
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE)
  }

  /**
   * 提交待办事务。
   * 提交期间新产生的操作进入下一批，不阻塞编辑。
   */
  async function flush(): Promise<void> {
    clearTimer()
    if (inflight) return inflight
    if (!meta.value || pending.value.length === 0) return

    const flowId = meta.value.id
    const batch = pending.value
    const graph = currentGraph()
    saveState.value = "saving"
    saveError.value = null

    inflight = (async () => {
      try {
        const { revision } = await flowApi.commit(flowId, {
          baseRevision: baseRevision.value,
          transactions: batch,
          graph
        })
        baseRevision.value = revision
        if (meta.value) meta.value = { ...meta.value, revision }

        // 提交期间可能又攒了新的，只摘掉这一批
        const committed = new Set(batch.map((tx) => tx.id))
        pending.value = pending.value.filter((tx) => !committed.has(tx.id))
        saveState.value = pending.value.length > 0 ? "dirty" : "saved"
        lastSavedAt.value = Date.now()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          saveState.value = "conflict"
          saveError.value = err.message
          return
        }
        // 网络问题等：保留 pending，等下次触发再补提交
        saveState.value = "error"
        saveError.value = err instanceof Error ? err.message : String(err)
      } finally {
        inflight = null
      }
    })()

    await inflight

    // 这一批走完后如果还有积压（提交期间新增的），继续排下一次。
    // 类型断言是因为 TS 只看到进入 await 前赋的 'saving'，看不到异步回调里的改动。
    if (pending.value.length > 0 && (saveState.value as SaveState) === "dirty") scheduleFlush()
  }

  /** Ctrl+S / 离开页面前：立刻提交并等它结束 */
  async function saveNow() {
    if (saveState.value === "error") saveState.value = "dirty"
    await flush()
  }

  // —— 生命周期 ——

  function load(detail: FlowDetail) {
    const graph = detail.graph ?? emptyGraph()
    meta.value = { ...detail }
    nodes.value = clone(graph.nodes ?? [])
    edges.value = clone(graph.edges ?? [])
    viewport.value = { ...(graph.viewport ?? { x: 0, y: 0, zoom: 1 }) }
    graphMeta.value = { ...(graph.meta ?? {}) }
    baseRevision.value = detail.revision

    undoStack.value = []
    redoStack.value = []
    pending.value = []
    openTx = null
    clearTimer()
    saveState.value = "saved"
    saveError.value = null

    // 刚打开时还没提交过，就拿服务端的 updatedAt 当「上次保存」
    const updatedAt = Date.parse(detail.updatedAt)
    lastSavedAt.value = Number.isNaN(updatedAt) ? null : updatedAt
  }

  function reset() {
    clearTimer()
    openTx = null
    meta.value = null
    nodes.value = []
    edges.value = []
    viewport.value = { x: 0, y: 0, zoom: 1 }
    graphMeta.value = {}
    baseRevision.value = 0
    undoStack.value = []
    redoStack.value = []
    pending.value = []
    saveState.value = "saved"
    saveError.value = null
    lastSavedAt.value = null
  }

  /** 视口不进历史、不产生操作，只在保存快照时随行 */
  function setViewport(next: FlowViewport) {
    viewport.value = { ...next }
  }

  function renameLocally(name: string) {
    if (meta.value) meta.value = { ...meta.value, name }
  }

  return {
    // 状态
    meta,
    nodes,
    edges,
    viewport,
    graphMeta,
    baseRevision,
    undoStack,
    redoStack,
    pending,
    saveState,
    saveError,
    lastSavedAt,
    // 派生
    canUndo,
    canRedo,
    dirty,
    // 行为
    apply,
    beginTransaction,
    commitTransaction,
    undo,
    redo,
    flush,
    saveNow,
    load,
    reset,
    setViewport,
    renameLocally,
    currentGraph
  }
})

export {
  applyOp,
  applyOps,
  getFlowCommand,
  invertOps,
  registerFlowCommand,
  registerFlowCommands,
  registeredFlowCommandTypes,
  type FlowCommand,
  type FlowCommandContext
} from "./registry"
export { FLOW_COMMANDS } from "./commands"
