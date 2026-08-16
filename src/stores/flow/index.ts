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
  type FlowUserState,
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
/** 按用户存的状态（视口…）的防抖窗口；它不进历史，存得勤一点也不贵 */
export const USER_STATE_DEBOUNCE = 600

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
  /** 我当前看哪儿。**视图状态，不是画布数据** —— 只走按用户存那条路 */
  const viewport = ref<FlowViewport>({ x: 0, y: 0, zoom: 1 })
  /**
   * 快照里那份视口，加载进来是什么就一直是什么。
   *
   * 它只是「谁都还没在这张画布上留下过视口时」的兜底。提交时原样写回，
   * **不跟着我平移/缩放走** —— 否则我拖一下画布就改了别人的共享数据，
   * 视图操作和数据变化又混到一起了。
   */
  const graphViewport = ref<FlowViewport>({ x: 0, y: 0, zoom: 1 })
  const graphMeta = ref<Record<string, unknown>>({})
  /** 按用户存的状态（视口…）；每人一份，跟画布内容分开走 */
  const userState = ref<FlowUserState>({})

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

  // —— 协同 ——

  /**
   * 协同层挂进来的两个出口（`composables/flow/useFlowSync`）。
   *
   * store 不认识 yjs，也不该认识：它只负责在「产生了一条事务」和「提交成功了」
   * 这两个时刻喊一声，广播怎么发是上层的事。没接协同时两个都是 null，行为不变。
   */
  let syncHooks: {
    /** 本地产生了一条事务，发给同一张画布上的其他人 */
    onTransaction?: (transaction: FlowTransaction) => void
    /** 本地提交成功，把新的 revision 告诉其他人，让他们对齐乐观锁基线 */
    onRevision?: (revision: number) => void
  } = {}

  function setSyncHooks(hooks: typeof syncHooks) {
    syncHooks = hooks
  }

  // —— 历史 ——

  function pushHistory(transaction: FlowTransaction) {
    const next = [...undoStack.value, transaction]
    // 超出上限丢最旧的，用户无感
    undoStack.value = next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next
    redoStack.value = []
  }

  function enqueue(transaction: FlowTransaction) {
    // 先广播再排队：别人看到变化不用等我这边防抖 800ms 落库
    syncHooks.onTransaction?.(transaction)

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
      // 注意是 graphViewport 不是 viewport：见上面的注释，个人视口不写进共享快照
      viewport: { ...graphViewport.value },
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
        // 同房间的人内容早就跟上了（事务先广播过），这里让他们的乐观锁基线也跟上
        syncHooks.onRevision?.(revision)

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

  // —— 协同收到的东西 ——

  /**
   * 应用别人广播过来的事务。
   *
   * **只改内容**：不进历史（撤销只该撤自己干的事）、不进 pending（落库是发起方的责任，
   * 两边都提交只会互相撞 409）。命令本身是幂等的（`node.add` 见到同 id 直接跳过），
   * 所以万一重放一次也不会加出第二个节点。
   */
  function applyRemote(transaction: FlowTransaction) {
    applyOps(transaction.ops)
  }

  /**
   * 别人提交成功了，把我的乐观锁基线对齐过去。
   *
   * 内容我已经通过 `applyRemote` 跟上了，缺的只是 revision —— 不对齐的话
   * 我下一次提交会带着一个陈旧的 baseRevision，必定撞 409。
   */
  function adoptRevision(revision: number) {
    if (revision <= baseRevision.value) return
    baseRevision.value = revision
    if (meta.value) meta.value = { ...meta.value, revision }
    lastSavedAt.value = Date.now()
  }

  // —— 按用户存的状态 ——

  /**
   * 视口这类状态**不是画布内容**：不进历史、不进操作日志、不涨 revision，
   * 因此也没有乐观锁和冲突 —— 只平移一下画布同样要能存下来，
   * 走的是独立的一条防抖链路（`PATCH /user-state`）。
   *
   * 加一种新的按用户存的东西：在 `FlowUserState` 加个字段、服务端加条校验，
   * 然后调 `setUserState('新字段', 值)` —— 防抖、重试、离开前落库都是现成的。
   */
  let userStateTimer: ReturnType<typeof setTimeout> | null = null
  /** 待落库的分区：只发改过的那些，没动过的不覆盖 */
  let userStatePatch: FlowUserState = {}
  let userStateInflight: Promise<void> | null = null

  function clearUserStateTimer() {
    if (userStateTimer !== null) {
      clearTimeout(userStateTimer)
      userStateTimer = null
    }
  }

  function setUserState<K extends keyof FlowUserState>(key: K, value: FlowUserState[K]) {
    userState.value = { ...userState.value, [key]: value }
    userStatePatch[key] = value

    clearUserStateTimer()
    userStateTimer = setTimeout(() => {
      userStateTimer = null
      void flushUserState()
    }, USER_STATE_DEBOUNCE)
  }

  async function flushUserState(): Promise<void> {
    clearUserStateTimer()
    if (userStateInflight) return userStateInflight
    if (!meta.value) return

    const patch = userStatePatch
    if (Object.keys(patch).length === 0) return
    userStatePatch = {}

    const flowId = meta.value.id
    userStateInflight = (async () => {
      try {
        await flowApi.patchUserState(flowId, patch)
      } catch {
        // 存不上不该弹提示打断人：这类状态丢了最多是下次打开回到上一个存住的视图。
        // 把没存成的合回队列（期间产生的新值优先），下次移动或离开时再试。
        userStatePatch = { ...patch, ...userStatePatch }
      } finally {
        userStateInflight = null
      }
    })()

    await userStateInflight
  }

  /** Ctrl+S / 离开页面前：立刻提交并等它结束 */
  async function saveNow() {
    if (saveState.value === "error") saveState.value = "dirty"
    await Promise.all([flush(), flushUserState()])
  }

  // —— 生命周期 ——

  function load(detail: FlowDetail) {
    const graph = detail.graph ?? emptyGraph()
    meta.value = { ...detail }
    nodes.value = clone(graph.nodes ?? [])
    edges.value = clone(graph.edges ?? [])
    graphMeta.value = { ...(graph.meta ?? {}) }
    baseRevision.value = detail.revision

    // 视口先看「我自己上次看哪儿」，没有才回落到快照里那份兜底的
    userState.value = { ...(detail.userState ?? {}) }
    userStatePatch = {}
    clearUserStateTimer()
    graphViewport.value = { ...(graph.viewport ?? { x: 0, y: 0, zoom: 1 }) }
    viewport.value = { ...(userState.value.viewport ?? graphViewport.value) }

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
    // 卸载时（关标签页、跳走）把还没落库的视口补一发，不等结果 ——
    // 路由跳走那条路已经 await 过一次，这里是兜底
    void flushUserState()
    clearUserStateTimer()
    userStatePatch = {}
    userState.value = {}
    openTx = null
    meta.value = null
    nodes.value = []
    edges.value = []
    viewport.value = { x: 0, y: 0, zoom: 1 }
    graphViewport.value = { x: 0, y: 0, zoom: 1 }
    graphMeta.value = {}
    baseRevision.value = 0
    undoStack.value = []
    redoStack.value = []
    pending.value = []
    saveState.value = "saved"
    saveError.value = null
    lastSavedAt.value = null
  }

  /**
   * 视口不进历史、不产生操作。它按用户存：谁看哪儿是谁自己的事，
   * 不会因为别人拖了一下画布就把我的视野也挪走。
   * 快照里那份 `graph.viewport` 只留作「第一次打开」的兜底。
   */
  function setViewport(next: FlowViewport) {
    const value = { ...next }
    viewport.value = value
    setUserState("viewport", value)
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
    userState,
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
    applyRemote,
    adoptRevision,
    setSyncHooks,
    beginTransaction,
    commitTransaction,
    undo,
    redo,
    flush,
    flushUserState,
    saveNow,
    load,
    reset,
    setViewport,
    setUserState,
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
