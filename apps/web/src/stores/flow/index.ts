import { computed, ref, shallowRef, type Ref } from "vue"
import { defineStore } from "pinia"
import { useDebounceFn } from "@vueuse/core"
import * as Y from "yjs"
import { flowApi } from "@/lib/api"
import {
  edgesMap,
  fromYEdge,
  fromYNode,
  metaMap,
  nodesMap,
  VIEWPORT_KEY,
  type FlowNodeGroup
} from "@shadecn/shared/flow-doc"
import { NODE_FORM_KEY, nodeFormOf } from "@shadecn/shared/flow-node-types"
import * as ops from "@shadecn/shared/flow-ops"
import { FlowOpError, type ConnectFrom, type FlowOpContext, type NodeFieldChanges } from "@shadecn/shared/flow-ops"
import type { FlowDetail, FlowSummary } from "@shadecn/shared/canvas"
import type {
  FlowEdge,
  FlowNode,
  FlowNodeRecord,
  FlowUserState,
  FlowViewport
} from "@shadecn/shared/flow-graph"
import {
  changedTopLevelKeys,
  createNodeProjector,
  projectMap,
  readFallbackViewport
} from "@/lib/flow-projection"

/**
 * 画布编辑器的状态中枢。
 *
 * **内容的唯一事实源是 Y.Doc**（`@shadecn/shared/flow-doc` 描述了它的形状），
 * 这里的 `nodes` / `edges` 只是它的响应式投影：Y.Map 一变就重算，组件照常用。
 *
 * 一条铁律：**所有内容变更都走 `mutate()`**。它把改动包进一个带 origin 的 Y 事务 ——
 * 只有这样改动才会被 `Y.UndoManager` 认领（撤销只撤自己的）、才会同步给别人、
 * 才会被服务端落库。组件不许直接碰 Y.Map。
 *
 * 这里**没有**保存、提交、revision、冲突这些概念了：
 * 改动即刻广播，服务端订阅并落库（`apps/server/collab/persistence.ts`）。
 * CRDT 天然收敛，不需要乐观锁，也就没有 409 可言。
 *
 * 视口是唯一的例外，它不是画布内容而是「我怎么看」，按用户存 ——
 * 而且**搭本地编辑的车**落库，自己不发请求，见 `noteLocalEdit()`。
 */

/**
 * 一串编辑停下来多久，把按用户存的状态（视口…）补落一次库。防抖窗口。
 *
 * 注意这只管**收尾**那一发：一串编辑的第一次是立刻发的（leading），不等这个窗口。
 * 没人编辑时既没有定时器也没有请求。
 */
export const USER_STATE_FLUSH_DELAY = 2000

/**
 * 收尾那一发最多能被往后推多久（`maxWait`）。
 *
 * 一直画下去，防抖窗口就会一直被重开、永远不触发；而这趟 PATCH 兼着会话心跳
 * （见 `noteLocalEdit()`），不能一直不发。所以给它一个天花板：连续编辑至少每 10s 落一次地。
 */
export const USER_STATE_FLUSH_MAX_WAIT = 10000

/**
 * 本地改动的事务 origin。
 *
 * `Y.UndoManager` 靠它区分「我干的」和「别人同步过来的」：只有带这个 origin 的
 * 事务进撤销栈，所以按 Ctrl+Z 永远只撤自己的操作，不会把同伴的改动一起撤了。
 */
export const LOCAL_ORIGIN = Symbol("flow-local")

/**
 * 「从内容派生出来、顺手记进文档」的事务 origin（眼下只有媒体节点按资源记下的尺寸，`recordNodeSize`）。
 *
 * 照样广播、落库，但**不进撤销栈**：它不是用户的操作，只是把「量过一次的结果」存下来 ——
 * 打开画布什么都没做就按 Ctrl+Z，撤掉的不该是一个尺寸。
 */
export const DERIVED_ORIGIN = Symbol("flow-derived")

/**
 * 导演台里的改动的事务 origin（docs/07 §7.6）。
 *
 * 照样广播、落库（协同层和服务端不看 origin），也照样算一次编辑（`noteLocalEdit()`，会话心跳），
 * 但**画布的撤销栈不跟踪它**：画布的 `Y.UndoManager` 只认 {@link LOCAL_ORIGIN}。导演台打开时为那个节点另建一个
 * 只跟踪这个 origin 的撤销栈（{@link createNodeHistory}），关掉就销毁 —— 所以导演台里的 Ctrl+Z 撤不到画布上的操作，
 * 关掉导演台后画布上的 Ctrl+Z 也撤不到导演台里的改动。
 */
export const DIRECTOR_ORIGIN = Symbol("flow-director")

/** 连续多久内的改动并成一次撤销（Y.UndoManager 的 captureTimeout） */
export const UNDO_CAPTURE_TIMEOUT = 400

/** 某个节点的 `data` 变了（{@link useFlowStore} 的 `onNodeDataChange`） */
export interface NodeDataChange {
  /** 变了哪些 `data` 键；`null` = 说不清（节点整个换了 / 被删了 / `data` 这一组被整块替换） */
  keys: ReadonlySet<string> | null
  /** 这次改动是不是从别处同步来的（协同的同伴、agent、离线缓存回放）—— `transaction.local === false` */
  remote: boolean
}

/** 一个节点自己的撤销栈（{@link useFlowStore} 的 `createNodeHistory`） */
export interface NodeHistory {
  readonly canUndo: Readonly<Ref<boolean>>
  readonly canRedo: Readonly<Ref<boolean>>
  undo(): void
  redo(): void
  /** 让下一次改动另起一条撤销记录（同 `separateUndo`） */
  separate(): void
  /** 用完必须调：销毁这份 UndoManager；之后 undo / redo 什么都不做 */
  destroy(): void
}

export const useFlowStore = defineStore("flow", () => {
  // —— 状态 ——

  const meta = ref<FlowSummary | null>(null)
  /** 我当前看哪儿。**视图状态，不是画布数据** —— 只走按用户存那条路 */
  const viewport = ref<FlowViewport>({ x: 0, y: 0, zoom: 1 })
  /** 按用户存的状态（视口…）；每人一份，跟画布内容分开走 */
  const userState = ref<FlowUserState>({})

  /**
   * Y.Doc 的响应式投影。**只读** —— 要改内容走 mutate()。
   *
   * 节点带着派生的 `inputs`（连进来的线 + 上游对应端口的产出），由投影层增量算出；
   * 没受影响的节点保持上一轮的对象引用（见 `createNodeProjector`）。
   */
  const nodes = shallowRef<FlowNode[]>([])
  const edges = shallowRef<FlowEdge[]>([])

  /** 按 id 查节点。节点组件（`useFlowNode`）靠它 O(1) 取自己那一份，而不是每个都扫一遍数组 */
  const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])))
  const graphMeta = shallowRef<Record<string, unknown>>({})

  const canUndo = ref(false)
  const canRedo = ref(false)

  /** 当前接管内容的文档；没连上协同时为 null，此时画布是只读的空图 */
  let doc: Y.Doc | null = null
  let undoManager: Y.UndoManager | null = null
  let detachDoc: (() => void) | null = null
  /** 当前文档上活着的节点撤销栈；换文档 / 卸下文档时一并销毁 */
  const nodeHistories = new Set<NodeHistory>()
  /** 节点 id → 订了这个节点 `data` 变化的回调 */
  const nodeDataListeners = new Map<string, Set<(change: NodeDataChange) => void>>()

  // —— 投影 ——

  /**
   * 上一轮解析出来的节点 / 边，按 id 存着。
   *
   * 有它才谈得上「增量」：一次拖动只动一个节点，没道理把整张图重新解析一遍。
   * 复用对象引用还有第二重好处 —— Vue Flow 靠引用判断节点要不要重新同步，
   * 没变的节点它连碰都不碰。
   */
  const nodeCache = new Map<string, FlowNodeRecord>()
  const edgeCache = new Map<string, FlowEdge>()
  /** 存下来的节点（不含 inputs），`projectMap` 的产物；inputs 由下面的投影器补上 */
  let records: FlowNodeRecord[] = []
  const projector = createNodeProjector()

  /**
   * @param changed 这一轮变了哪些顶层键；`null` = 说不清，全量重算
   */
  function syncNodes(changed: Set<string> | null = null) {
    if (!doc) {
      nodeCache.clear()
      records = []
      syncEdges(null)
      return
    }
    records = projectMap(nodesMap(doc), nodeCache, changed, fromYNode)
    // 节点增删会让边变成悬空 / 不再悬空，所以边跟着重算一遍可见性
    syncEdges(changed === null ? null : new Set())
  }

  /**
   * 边变了（或者节点变了、顺路过来）：重算可见的边，再把节点连同 inputs 投影一遍。
   *
   * inputs 依赖边，所以**节点数组在这里才定稿**，而不是在 `syncNodes` 里 ——
   * 只改一条边时节点的记录一个都没变，但下游那个节点的 inputs 变了，它得换新对象。
   */
  function syncEdges(changed: Set<string> | null = null) {
    if (!doc) {
      edgeCache.clear()
      projector.reset()
      edges.value = []
      nodes.value = []
      return
    }
    const alive = new Set(records.map((node) => node.id))
    const projected = projectMap(edgesMap(doc), edgeCache, changed, fromYEdge)
    // 端点没了的边不进画面（文档里那条由服务端的 gc 清）
    edges.value = projected.filter((edge) => alive.has(edge.source) && alive.has(edge.target))
    nodes.value = projector.project(records, edges.value)
  }

  function syncMeta() {
    if (!doc) {
      graphMeta.value = {}
      return
    }
    const all = metaMap(doc).toJSON() as Record<string, unknown>
    delete all[VIEWPORT_KEY]
    graphMeta.value = all
  }

  function syncHistory() {
    canUndo.value = (undoManager?.undoStack.length ?? 0) > 0
    canRedo.value = (undoManager?.redoStack.length ?? 0) > 0
  }

  /**
   * 接管一个 Y.Doc —— 协同层连上之后调一次。
   *
   */
  function attachDoc(next: Y.Doc) {
    // 同一个文档就什么都不用做。协同挂上 awareness 之后会换一个新的 session 对象
    // （在场层靠它重挂钩子），但文档还是那一个 —— 重挂一遍会白白清空撤销栈
    if (doc === next) return
    detachDoc?.()
    doc = next

    const yNodes = nodesMap(next)
    const yEdges = edgesMap(next)
    const yMeta = metaMap(next)

    // observeDeep：节点位置、data 里的字段都藏在嵌套的 Y.Map 里，
    // 只观察顶层的话拖动和改标题都收不到通知
    /* eslint-disable @typescript-eslint/no-explicit-any -- Yjs 的 observeDeep 回调签名 */
    const onNodesChanged = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      syncNodes(changedTopLevelKeys(events))
      if (nodeDataListeners.size > 0) notifyNodeData(events, transaction)
    }
    const onEdgesChanged = (events: Y.YEvent<any>[]) => syncEdges(changedTopLevelKeys(events))
    /* eslint-enable @typescript-eslint/no-explicit-any */

    yNodes.observeDeep(onNodesChanged)
    yEdges.observeDeep(onEdgesChanged)
    yMeta.observe(syncMeta)

    // 只跟踪本地 origin：撤销栈里永远只有我自己干的事
    undoManager = new Y.UndoManager([yNodes, yEdges, yMeta], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: UNDO_CAPTURE_TIMEOUT
    })
    undoManager.on("stack-item-added", syncHistory)
    undoManager.on("stack-item-popped", syncHistory)

    detachDoc = () => {
      for (const history of [...nodeHistories]) history.destroy()
      yNodes.unobserveDeep(onNodesChanged)
      yEdges.unobserveDeep(onEdgesChanged)
      yMeta.unobserve(syncMeta)
      undoManager?.destroy()
      undoManager = null
      doc = null
      detachDoc = null
    }

    syncNodes(null)
    syncMeta()
    syncHistory()
  }

  /**
   * 把这一批节点事件按「哪个节点的 data 变了哪些键」分好，交给订了那个节点的回调。
   *
   * `observeDeep` 的事件路径相对 `nodes` 这张表：`[]` = 节点增删，`[id]` = 节点自己那一层（布局、整组替换），
   * `[id, 'data']` = `data` 里的键。只读、不写，回调抛错不影响投影。
   */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs 的 observeDeep 事件类型 */
  function notifyNodeData(events: Y.YEvent<any>[], transaction: Y.Transaction) {
    const changed = new Map<string, Set<string> | null>()
    const everything = (id: string) => changed.set(id, null)
    for (const event of events) {
      const path = event.path
      // 只在观察回调里取 changes（Yjs 的要求）；键级的变化在 changes.keys 上
      const keysChanged = event.changes.keys
      if (path.length === 0) {
        for (const id of keysChanged.keys()) if (nodeDataListeners.has(id)) everything(id)
        continue
      }
      const id = String(path[0])
      if (!nodeDataListeners.has(id) || changed.get(id) === null) continue
      if (path.length === 1) {
        if (keysChanged.has("data")) everything(id)
        continue
      }
      if (path[1] !== "data") continue
      if (path.length > 2) {
        everything(id)
        continue
      }
      const keys = changed.get(id) ?? new Set<string>()
      for (const key of keysChanged.keys()) keys.add(key)
      changed.set(id, keys)
    }
    const remote = !transaction.local
    for (const [id, keys] of changed) {
      if (keys && keys.size === 0) continue
      for (const listener of nodeDataListeners.get(id) ?? []) {
        try {
          listener({ keys, remote })
        } catch (error) {
          console.error(`[flow] 节点 ${id} 的 data 变化回调出错`, error)
        }
      }
    }
  }

  /**
   * 订一个节点 `data` 的变化（含是不是远端来的）。**只用来给界面反馈**（比如导演台高亮被远端改过的对象），
   * 不是读数据的通道 —— 数据照旧从 `nodes` / `nodeById` 读。返回退订函数；换文档不用重订。
   */
  function onNodeDataChange(nodeId: string, listener: (change: NodeDataChange) => void): () => void {
    let set = nodeDataListeners.get(nodeId)
    if (!set) nodeDataListeners.set(nodeId, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0 && nodeDataListeners.get(nodeId) === set) nodeDataListeners.delete(nodeId)
    }
  }

  /**
   * 给一个节点建它自己的撤销栈：作用域是这个节点的 Y.Map，只跟踪 {@link DIRECTOR_ORIGIN}（{@link mutateDirector} 写的）。
   *
   * 和画布那份互不相干：画布的只跟踪 `LOCAL_ORIGIN`，这一份不跟踪它；两边的撤销事务 origin 是各自的 UndoManager，
   * 对方也不跟踪。没有文档或节点不在时返回 null。用完调 `destroy()`；换文档时由 store 一并销毁。
   */
  function createNodeHistory(nodeId: string): NodeHistory | null {
    if (!doc) return null
    const target = nodesMap(doc).get(nodeId)
    if (!(target instanceof Y.Map)) return null
    let manager: Y.UndoManager | null = new Y.UndoManager(target, {
      trackedOrigins: new Set([DIRECTOR_ORIGIN]),
      captureTimeout: UNDO_CAPTURE_TIMEOUT
    })
    const canUndo = ref(false)
    const canRedo = ref(false)
    const sync = () => {
      canUndo.value = (manager?.undoStack.length ?? 0) > 0
      canRedo.value = (manager?.redoStack.length ?? 0) > 0
    }
    manager.on("stack-item-added", sync)
    manager.on("stack-item-popped", sync)
    const history: NodeHistory = {
      canUndo,
      canRedo,
      undo() {
        if (!manager) return
        manager.undo()
        noteLocalEdit()
      },
      redo() {
        if (!manager) return
        manager.redo()
        noteLocalEdit()
      },
      separate() {
        manager?.stopCapturing()
      },
      destroy() {
        if (!manager) return
        manager.destroy()
        manager = null
        nodeHistories.delete(history)
        sync()
      }
    }
    nodeHistories.add(history)
    return history
  }

  /**
   * 首次打开（自己还没存过视口）时，把快照里那份兜底视口应用上。
   *
   * **不能在 `attachDoc` 里做**：接管发生在连接建立的那一刻，文档还是刚 new 出来的
   * 空壳，同步的内容（包括 meta.viewport）尚未到达，读出来永远是空。
   * 调用时机是画布挂载（pane-ready）—— 编辑器的加载门槛保证那时内容已经就位。
   */
  function applyFallbackViewport(): boolean {
    if (userState.value.viewport || !doc) return false
    const fallback = readFallbackViewport(doc)
    if (!fallback) return false
    viewport.value = fallback
    return true
  }

  function detach() {
    detachDoc?.()
    nodeCache.clear()
    edgeCache.clear()
    records = []
    projector.reset()
    nodes.value = []
    edges.value = []
    graphMeta.value = {}
    syncHistory()
  }

  // —— 唯一的写入口 ——

  /**
   * 改内容。**所有变更都必须从这里走。**
   *
   * 包成一个带 `LOCAL_ORIGIN` 的 Y 事务：这样它才进撤销栈、才广播、才落库。
   * `label` 只是给调试和日志用的，CRDT 不需要它 —— 撤销的粒度由
   * `Y.UndoManager` 按时间窗口（`UNDO_CAPTURE_TIMEOUT`）自己合并。
   */
  function mutate<T>(change: (context: FlowMutationContext) => T, label?: string): T | undefined {
    return transactAs(LOCAL_ORIGIN, change, label)
  }

  /**
   * 导演台里的改动 —— 和 {@link mutate} 一样是一个事务、一样广播落库、一样算一次编辑，
   * 区别只在 origin 是 {@link DIRECTOR_ORIGIN}：画布的撤销栈不收它，导演台自己的（`createNodeHistory`）收。
   *
   * 操作抛出的异常原样抛给调用方（导演台 ops 先校验后动手，抛出时文档没被改动），由界面决定怎么提示。
   */
  function mutateDirector<T>(change: (context: FlowMutationContext) => T, label?: string): T | undefined {
    return transactAs(DIRECTOR_ORIGIN, change, label)
  }

  function transactAs<T>(origin: symbol, change: (context: FlowMutationContext) => T, label?: string): T | undefined {
    if (!doc) return undefined
    const target = doc
    let result: T | undefined
    target.transact(() => {
      result = change(ops.opContext(target))
    }, origin)
    if (label) lastLabel.value = label
    noteLocalEdit()
    return result
  }

  /** 最近一次改动的名字，只用来在界面上给个反馈 */
  const lastLabel = ref<string | null>(null)

  /**
   * 让下一次改动**另起一条撤销记录**，不要和刚才那次并进同一条。
   *
   * `Y.UndoManager` 默认把 400ms 内的改动并成一次撤销 —— 连点两次「添加节点」
   * 会变成一次撤销撤掉两个。语义上独立的操作之间调一下这个。
   */
  function separateUndo() {
    undoManager?.stopCapturing()
  }

  function undo() {
    undoManager?.undo()
    noteLocalEdit()
  }

  function redo() {
    undoManager?.redo()
    noteLocalEdit()
  }

  // —— 内容操作（都建立在 mutate 之上）——
  //
  // 每个方法 = `mutate(ctx => ops.xxx(ctx, …))`：规则（连线怎么选端口、删分组怎么解散、key 的类型不能换…）
  // 全在 `@shadecn/shared/flow-ops`，agent 的画布工具调的是同一份。这里只管事务的 origin 和撤销栈。
  //
  // **目标不存在时**：这一层原来一律静默不做（拖着的节点被别人删了、写一个刚被删的节点），所以
  // 原子操作抛出的 `FlowOpError` 在这里吞掉（`lenient`）—— 抛出时操作还没写任何东西，吞掉 = 什么都没发生。
  // 例外是 `connect` / `addConnectedNode`：连不上的原因要提示给人，它们把 `FlowOpError` 原样抛给调用方。

  /** 吞掉原子操作的前提错误（此时文档没被改动）；别的异常照抛 */
  function lenient<T>(run: () => T): T | undefined {
    try {
      return run()
    } catch (error) {
      if (error instanceof FlowOpError) return undefined
      throw error
    }
  }

  function addNode(node: FlowNodeRecord) {
    mutate((ctx) => ops.createNode(ctx, node), "新增节点")
  }

  /** 原样放进一条已经定好端口的边（不选端口、不校验）；新连一条线用 {@link connect} */
  function addEdge(edge: FlowEdge) {
    mutate((ctx) => ops.insertEdge(ctx, edge), "连线")
  }

  /**
   * 一次性加一批节点和边。
   *
   * 和分别调 `addNode` / `addEdge` 的区别在于它只有**一个** Y 事务：
   * 一条撤销、一条操作日志、一次广播 —— 不会出现「节点到了、线还没到」的中间态。
   */
  function addElements(newNodes: FlowNodeRecord[], newEdges: FlowEdge[], label = "新增元素") {
    if (newNodes.length === 0 && newEdges.length === 0) return
    mutate((ctx) => {
      for (const node of newNodes) ops.createNode(ctx, node)
      for (const edge of newEdges) ops.insertEdge(ctx, edge)
    }, label)
  }

  /**
   * 从 `source` 连一条线到 `target`，端口由 shared 的 `resolveConnection` 选。
   * 连不上抛 `FlowOpError`（`message` 是给人看的原因），文档不动。
   */
  function connect(source: string, target: string, label = "连线"): FlowEdge | undefined {
    return mutate((ctx) => ops.connect(ctx, { source, target }), label)
  }

  /**
   * 新建一个节点并从 `from.source` 连一条线过来，**一个事务**（一条撤销两样都拿掉）。
   * 连线规则按新节点的 data 判；连不上抛 `FlowOpError`，节点也不建。
   */
  function addConnectedNode(node: FlowNodeRecord, from: ConnectFrom, label = "新增相连节点") {
    return mutate((ctx) => ops.createConnectedNode(ctx, node, from), label)
  }

  /**
   * 复制一个节点（运行态重置、不带连线，见 `ops.duplicateNode`），返回副本；原件不存在返回 null。
   * 新 id 和错开多少由调用方给。
   */
  function duplicateNode(
    sourceId: string,
    options: { id: string; offset: { x: number; y: number } },
    label = "新增节点"
  ): FlowNodeRecord | null {
    return mutate((ctx) => lenient(() => ops.duplicateNode(ctx, sourceId, options)), label) ?? null
  }

  /**
   * 给图片 / 视频节点挂上素材（上传完成）：写 `src`（/ `poster`），没有连入的线就成 asset 形态，
   * 有就保持 generate —— 一个事务、一步撤销（`ops.attachAsset`）。节点在上传途中被删了就什么都不做。
   */
  function attachAsset(nodeId: string, asset: { src: string; poster?: string }, label = "上传素材") {
    mutate((ctx) => lenient(() => ops.attachAsset(ctx, nodeId, asset)), label)
  }

  /**
   * 打组：新建一个分组框，并把一批节点挂到它下面 —— 同一个事务（理由见 `ops.groupNodes`）。
   *
   * `children` 里的位置是**相对分组框左上角**的，调用方负责换算（见 `groupSelection`）。
   * `extent: 'parent'` 渲染层的时机问题在 `useFlowCanvas` 的 `extentReady` 挡，不靠晚写文档。
   */
  function groupNodes(
    group: FlowNodeRecord,
    children: Map<string, { x: number; y: number }>,
    label = "打组"
  ) {
    mutate((ctx) => ops.groupNodes(ctx, group, children), label)
  }

  function moveNodes(positions: Map<string, { x: number; y: number }>, label = "移动节点") {
    mutate((ctx) => ops.moveNodes(ctx, positions), label)
  }

  /** 改一个节点的尺寸，顺带改位置（同一个事务，见 `ops.resizeNode`）；节点不在就什么都不做 */
  function resizeNode(
    nodeId: string,
    size: { width: number; height: number; x?: number; y?: number },
    label = "调整大小"
  ) {
    mutate((ctx) => lenient(() => ops.resizeNode(ctx, nodeId, size)), label)
  }

  /**
   * 把按资源量出来的尺寸记进节点布局（`width` / `height`），下次打开直接按这个尺寸画，不必等资源加载完。
   *
   * 和 `resizeNode` 写的是同两个键，区别在 origin：这是 {@link DERIVED_ORIGIN}，不进撤销栈、
   * 也不 `noteLocalEdit()`（只是看了一眼画布，不算编辑，不发心跳）。值没变就什么都不写 ——
   * 每次资源加载完都会调一次，几个人同时打开也只是写进同样的值。
   */
  function recordNodeSize(nodeId: string, size: { width: number; height: number }) {
    if (!doc) return
    const target = nodesMap(doc).get(nodeId)
    if (!target) return
    if (target.get("width") === size.width && target.get("height") === size.height) return
    doc.transact(() => {
      target.set("width", size.width)
      target.set("height", size.height)
    }, DERIVED_ORIGIN)
  }

  /**
   * 改一个节点**某一组**（metadata / data / runtime）上的若干键 —— **写和删在同一个事务里**（`ops.writeNodeFields`）。
   *
   * `remove` 是「平铺分键」（`@shadecn/shared/flow-collection`）用得上的那一半：删掉集合里一个元素就是删掉一个键。
   * 删和写必须同笔 —— 「删掉角色 A、同时删掉它名下的轨」要一步撤干净。
   *
   * 节点不存在、这一组的 key 上是别的类型、要碰的字段类型对不上：什么都不写（key 的类型首次写入即固定）。
   *
   * **素材字段不走这里**：有形态的类型（图片 / 视频）上，`data.form` / `src` / `poster` 只能经
   * `attachAsset`（挂素材）和连线（asset → generate）变；这里碰它们的写入整笔拒绝并告警，
   * 否则形态规则（docs/13 §3.7）能被绕过。
   */
  function writeNode(
    nodeId: string,
    group: FlowNodeGroup,
    changes: NodeFieldChanges,
    label = "修改节点"
  ) {
    mutate((ctx) => {
      if (group === "data") {
        const guarded = guardedAssetKeys(changes)
        const node = guarded.length > 0 ? ops.readNodeRecord(ctx, nodeId) : null
        if (node && nodeFormOf(node.type, node.data) !== null) {
          console.warn(`[flow] 拒绝直接写 ${node.type} 节点 ${nodeId} 的 ${guarded.join(" / ")}：请用 attachAsset 或连线`)
          return undefined
        }
      }
      return lenient(() => ops.writeNodeFields(ctx, nodeId, group, changes))
    }, label)
  }

  /** 有形态的节点上只能经 `attachAsset` / 连线改的 data 键 */
  const ASSET_GUARDED_KEYS = [NODE_FORM_KEY, "src", "poster"]

  /** 这笔改动里碰了哪些受保护的键（写和删都算；值为 undefined 的 set 不会真写，不算） */
  function guardedAssetKeys(changes: NodeFieldChanges): string[] {
    const touched = new Set<string>(changes.remove ?? [])
    for (const [key, value] of Object.entries(changes.set ?? {})) if (value !== undefined) touched.add(key)
    return ASSET_GUARDED_KEYS.filter((key) => touched.has(key))
  }

  /**
   * 删元素：连着的边一起删，删分组只解散（子节点换算回画布坐标），见 `ops.removeElements`。
   */
  function removeElements(nodeIds: Iterable<string>, edgeIds: Iterable<string>) {
    const doomedNodes = [...nodeIds]
    const doomedEdges = [...edgeIds]
    // 什么都没点名就不开事务（不算一次编辑，不发心跳）
    if (doomedNodes.length === 0 && doomedEdges.length === 0) return
    mutate((ctx) => ops.removeElements(ctx, doomedNodes, doomedEdges), "删除")
  }

  // —— 按用户存的状态 ——

  /**
   * 视口这类状态**不是画布内容**：不进 Y.Doc、不进撤销、不广播给别人 ——
   * 谁看哪儿是谁自己的事，不该因为别人拖了一下画布就把我的视野也挪走。
   *
   * 加一种新的按用户存的东西：在 `FlowUserState` 加个字段、服务端加条校验，
   * 然后调 `setUserState('新字段', 值)` —— 攒批、重试、离开前落库都是现成的。
   */
  let userStatePatch: FlowUserState = {}
  let userStateInflight: Promise<void> | null = null

  /** 距上次落库之后又发生了几次本地编辑 —— 0 就说明收尾那一发没什么可送的 */
  let editsSinceFlush = 0
  /** 是不是正处在一串连续编辑当中（leading 那一发已经出去了） */
  let burstOpen = false

  function flushUserStateNow() {
    // 没有攒下的字段就把当前视口当成要存的东西发出去 —— 这一趟是心跳
    if (Object.keys(userStatePatch).length === 0) setUserState("viewport", { ...viewport.value })
    void flushUserState()
  }

  /**
   * 一串编辑的**收尾**：手停下来一个窗口之后再补一发。
   *
   * leading 只保证「开头那下立刻上去」，之后的改动不能就这么丢了 —— 它们同样是
   * 要落库的值（视口、以后别的按用户存的字段），所以后面这段仍然走防抖：
   * 连续操作合成一次请求，手一停就补齐。一直不停手则由 `maxWait` 顶着。
   */
  const scheduleTailFlush = useDebounceFn(
    () => {
      burstOpen = false
      // leading 之后没再发生什么，就不用白跑一趟
      if (editsSinceFlush > 0 || Object.keys(userStatePatch).length > 0) flushUserStateNow()
    },
    USER_STATE_FLUSH_DELAY,
    { maxWait: USER_STATE_FLUSH_MAX_WAIT }
  )

  /** 记下来就完了，**不发请求** —— 等下一次本地编辑或离开页面时顺路带走 */
  function setUserState<K extends keyof FlowUserState>(key: K, value: FlowUserState[K]) {
    userState.value = { ...userState.value, [key]: value }
    userStatePatch[key] = value
  }

  /**
   * 本地编辑发生了 —— 攒着的视图状态搭这趟车走。
   *
   * 平移、缩放自己**不发请求**：那是「我怎么看」，不值得为它单独发一次 HTTP。
   * 画布内容改走 Yjs 之后这一点尤其要紧，否则它就成了整个编辑器唯一还在
   * 周期性发请求的东西 —— 看了一眼画布就一路 PATCH 上去，很没道理。
   * 绑在编辑上之后：真的动了画布才存，没人编辑就一个请求都没有。
   * 「只平移没编辑」那种情况由离开前的 `flushUserState()` 兜住。
   *
   * **一次编辑至少产生一次 PATCH，哪怕视图没动过** —— 这一趟同时是会话的心跳。
   * 内容走 WebSocket 之后，编辑本身不再产生任何 HTTP 请求，而会话的空闲计时
   * （Keycloak 的 SSO Session Idle）只认真实请求；服务端的协同复验是只读的、
   * 特意不续期（`apps/server/auth/session.ts` 的 `LoadSessionOptions.refresh`），
   * 否则挂着标签页就永远不会超时。所以：在编辑 = 隔一阵一次 PATCH = 会话续着，
   * 只看不改 = 一个请求都没有 = 该超时就超时。
   *
   * 落库时机是**先立刻发一次，再防抖收尾**：空闲之后的第一次编辑不等窗口，当场就走
   * （纯防抖的滞后感就在这儿 —— 手一直不停它就一直不发，而这趟还兼着心跳）；
   * 这之后的改动照旧防抖，一串连续操作合成一次请求，手一停补齐，
   * 一直不停手则由 `USER_STATE_FLUSH_MAX_WAIT` 顶着。**没有哪次改动会被丢掉。**
   */
  function noteLocalEdit() {
    editsSinceFlush++
    // 空闲之后的第一次编辑：当场发，不等窗口
    if (!burstOpen) {
      burstOpen = true
      flushUserStateNow()
    }
    void scheduleTailFlush()
  }

  async function flushUserState(): Promise<void> {
    // 这一趟会把攒着的都送走，收尾那发就不必再送一遍
    editsSinceFlush = 0
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

  function setViewport(next: FlowViewport) {
    const value = { ...next }
    viewport.value = value
    setUserState("viewport", value)
  }

  /** 离开页面前：把按用户存的那点东西落库。内容不用管，它一直是同步的 */
  async function saveNow() {
    await flushUserState()
  }

  // —— 生命周期 ——

  /** 只灌文档元信息；内容不从这里来，它来自 Y.Doc */
  function load(detail: FlowDetail) {
    meta.value = { ...detail }
    userState.value = { ...(detail.userState ?? {}) }
    userStatePatch = {}
    // 换了张画布：下一次编辑重新算作一串的开头，立刻发
    burstOpen = false
    editsSinceFlush = 0
    viewport.value = userState.value.viewport ?? { x: 0, y: 0, zoom: 1 }
  }

  function reset() {
    // 卸载时（关标签页、跳走）把还没落库的视口补一发，不等结果
    void flushUserState()
    detach()
    userStatePatch = {}
    burstOpen = false
    editsSinceFlush = 0
    userState.value = {}
    meta.value = null
    viewport.value = { x: 0, y: 0, zoom: 1 }
    lastLabel.value = null
  }

  function renameLocally(name: string) {
    if (meta.value) meta.value = { ...meta.value, name }
  }

  return {
    // 状态
    meta,
    nodes,
    nodeById,
    edges,
    graphMeta,
    viewport,
    userState,
    canUndo,
    canRedo,
    lastLabel,
    // 内容
    attachDoc,
    applyFallbackViewport,
    detach,
    mutate,
    mutateDirector,
    createNodeHistory,
    onNodeDataChange,
    separateUndo,
    undo,
    redo,
    addNode,
    addEdge,
    addElements,
    connect,
    addConnectedNode,
    duplicateNode,
    attachAsset,
    groupNodes,
    moveNodes,
    resizeNode,
    recordNodeSize,
    writeNode,
    removeElements,
    // 视图状态
    setViewport,
    setUserState,
    flushUserState,
    saveNow,
    // 文档
    load,
    reset,
    renameLocally
  }
})

/** `mutate()` 回调拿到的东西 —— 想干什么都得通过它们；也是 `@shadecn/shared/flow-ops` 每个操作的第一个参数 */
export type FlowMutationContext = FlowOpContext
