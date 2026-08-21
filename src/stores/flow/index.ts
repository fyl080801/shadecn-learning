import { ref, shallowRef } from "vue"
import { defineStore } from "pinia"
import { useDebounceFn } from "@vueuse/core"
import * as Y from "yjs"
import { flowApi } from "@/lib/api"
import {
  changedTopLevelKeys,
  edgesMap,
  fromYEdge,
  fromYNode,
  metaMap,
  nodeData,
  nodesMap,
  projectMap,
  readFallbackViewport,
  toYEdge,
  toYNode,
  VIEWPORT_KEY
} from "@/lib/flow-doc"
import type {
  FlowDetail,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  FlowSummary,
  FlowUserState,
  FlowViewport
} from "@/types/flow"

/**
 * 画布编辑器的状态中枢。
 *
 * **内容的唯一事实源是 Y.Doc**（`src/lib/flow-doc.ts` 描述了它的形状），
 * 这里的 `nodes` / `edges` 只是它的响应式投影：Y.Map 一变就重算，组件照常用。
 *
 * 一条铁律：**所有内容变更都走 `mutate()`**。它把改动包进一个带 origin 的 Y 事务 ——
 * 只有这样改动才会被 `Y.UndoManager` 认领（撤销只撤自己的）、才会同步给别人、
 * 才会被服务端落库。组件不许直接碰 Y.Map。
 *
 * 这里**没有**保存、提交、revision、冲突这些概念了：
 * 改动即刻广播，服务端订阅并落库（`server/collab/persistence.ts`）。
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

/** 连续多久内的改动并成一次撤销（Y.UndoManager 的 captureTimeout） */
export const UNDO_CAPTURE_TIMEOUT = 400

export const useFlowStore = defineStore("flow", () => {
  // —— 状态 ——

  const meta = ref<FlowSummary | null>(null)
  /** 我当前看哪儿。**视图状态，不是画布数据** —— 只走按用户存那条路 */
  const viewport = ref<FlowViewport>({ x: 0, y: 0, zoom: 1 })
  /** 按用户存的状态（视口…）；每人一份，跟画布内容分开走 */
  const userState = ref<FlowUserState>({})

  /** Y.Doc 的响应式投影。**只读** —— 要改内容走 mutate() */
  const nodes = shallowRef<FlowNode[]>([])
  const edges = shallowRef<FlowEdge[]>([])
  const graphMeta = shallowRef<Record<string, unknown>>({})

  const canUndo = ref(false)
  const canRedo = ref(false)

  /** 当前接管内容的文档；没连上协同时为 null，此时画布是只读的空图 */
  let doc: Y.Doc | null = null
  let undoManager: Y.UndoManager | null = null
  let detachDoc: (() => void) | null = null

  // —— 投影 ——

  /**
   * 上一轮解析出来的节点 / 边，按 id 存着。
   *
   * 有它才谈得上「增量」：一次拖动只动一个节点，没道理把整张图重新解析一遍。
   * 复用对象引用还有第二重好处 —— Vue Flow 靠引用判断节点要不要重新同步，
   * 没变的节点它连碰都不碰。
   */
  const nodeCache = new Map<string, FlowNode>()
  const edgeCache = new Map<string, FlowEdge>()

  /**
   * @param changed 这一轮变了哪些顶层键；`null` = 说不清，全量重算
   */
  function syncNodes(changed: Set<string> | null = null) {
    if (!doc) {
      nodeCache.clear()
      nodes.value = []
      syncEdges(null)
      return
    }
    nodes.value = projectMap(nodesMap(doc), nodeCache, changed, fromYNode)
    // 节点增删会让边变成悬空 / 不再悬空，所以边跟着重算一遍可见性
    syncEdges(changed === null ? null : new Set())
  }

  function syncEdges(changed: Set<string> | null = null) {
    if (!doc) {
      edgeCache.clear()
      edges.value = []
      return
    }
    const alive = new Set(nodes.value.map((node) => node.id))
    const projected = projectMap(edgesMap(doc), edgeCache, changed, fromYEdge)
    // 端点没了的边不进画面（文档里那条由服务端的 gc 清）
    edges.value = projected.filter((edge) => alive.has(edge.source) && alive.has(edge.target))
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
    const onNodesChanged = (events: Y.YEvent<any>[]) => syncNodes(changedTopLevelKeys(events))
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
  function mutate(change: (context: FlowMutationContext) => void, label?: string) {
    if (!doc) return
    const target = doc
    target.transact(() => {
      change({
        doc: target,
        nodes: nodesMap(target),
        edges: edgesMap(target),
        meta: metaMap(target)
      })
    }, LOCAL_ORIGIN)
    if (label) lastLabel.value = label
    noteLocalEdit()
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

  function addNode(node: FlowNode) {
    mutate(({ nodes: map }) => map.set(node.id, toYNode(node)), "新增节点")
  }

  function addEdge(edge: FlowEdge) {
    mutate(({ edges: map }) => map.set(edge.id, toYEdge(edge)), "连线")
  }

  /**
   * 一次性加一批节点和边（复制节点这类「节点 + 它的连线一起进来」的动作）。
   *
   * 和分别调 `addNode` / `addEdge` 的区别在于它只有**一个** Y 事务：
   * 一条撤销、一条操作日志、一次广播 —— 不会出现「节点到了、线还没到」的中间态。
   */
  function addElements(newNodes: FlowNode[], newEdges: FlowEdge[], label = "新增元素") {
    if (newNodes.length === 0 && newEdges.length === 0) return
    mutate(({ nodes: nodeMap, edges: edgeMap }) => {
      for (const node of newNodes) nodeMap.set(node.id, toYNode(node))
      for (const edge of newEdges) edgeMap.set(edge.id, toYEdge(edge))
    }, label)
  }

  function moveNodes(positions: Map<string, { x: number; y: number }>, label = "移动节点") {
    mutate(({ nodes: map }) => {
      for (const [id, position] of positions) {
        map.get(id)?.set("position", { ...position })
      }
    }, label)
  }

  /**
   * 改一个节点的尺寸，顺带改位置。
   *
   * 从左上角往外拉时 Vue Flow 给的 `x`/`y` 会变（锚点在对角），所以位置得跟着一起写，
   * 而且必须在**同一个事务**里 —— 分两次写，别人会先看到一个位置变了但尺寸没变的中间态。
   */
  function resizeNode(
    nodeId: string,
    size: { width: number; height: number; x?: number; y?: number },
    label = "调整大小"
  ) {
    mutate(({ nodes: map }) => {
      const target = map.get(nodeId)
      if (!target) return
      target.set("width", size.width)
      target.set("height", size.height)
      if (size.x !== undefined && size.y !== undefined) {
        target.set("position", { x: size.x, y: size.y })
      }
    }, label)
  }

  function updateNodeData(nodeId: string, patch: Partial<FlowNodeData>, label = "修改节点") {
    mutate(({ doc: target }) => {
      const data = nodeData(target, nodeId)
      if (!data) return
      // 逐个 key 写：Y.Map 的合并粒度就是 key，整块替换会把别人同时改的字段盖掉
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) data.set(key, value)
      }
    }, label)
  }

  /**
   * 删元素。连着的边一起删 —— 留下悬空的边会让投影层直接把它过滤掉，
   * 那样界面上没了、数据里还在。
   */
  function removeElements(nodeIds: Iterable<string>, edgeIds: Iterable<string>) {
    const doomedNodes = new Set(nodeIds)
    const doomedEdges = new Set(edgeIds)
    for (const edge of edges.value) {
      if (doomedNodes.has(edge.source) || doomedNodes.has(edge.target)) doomedEdges.add(edge.id)
    }
    if (doomedNodes.size === 0 && doomedEdges.size === 0) return

    // 删掉一个分组，组里的节点要**留在原地**而不是跟着陪葬 —— 所以只解除归属。
    // 不解除的话它们的 parentNode 指向一个不存在的节点，位置会被当成相对坐标
    // 去加一个不存在的父节点，整组节点瞬间跳到画布原点附近。
    const orphaned = nodes.value.filter(
      (node) => node.parentNode !== undefined && doomedNodes.has(node.parentNode)
    )

    mutate(({ nodes: nodeMap, edges: edgeMap }) => {
      for (const id of doomedEdges) edgeMap.delete(id)
      for (const node of orphaned) {
        const target = nodeMap.get(node.id)
        if (!target) continue
        target.delete("parentNode")
        target.delete("extent")
        // parentNode 下的 position 是相对父节点的，脱离分组之后得换算回画布坐标，
        // 否则节点会跳到画布原点那一带
        const parent = nodes.value.find((item) => item.id === node.parentNode)
        if (parent) {
          target.set("position", {
            x: parent.position.x + node.position.x,
            y: parent.position.y + node.position.y
          })
        }
      }
      for (const id of doomedNodes) nodeMap.delete(id)
    }, "删除")
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
   * 特意不续期（`server/auth/session.ts` 的 `LoadSessionOptions.refresh`），
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
    separateUndo,
    undo,
    redo,
    addNode,
    addEdge,
    addElements,
    moveNodes,
    resizeNode,
    updateNodeData,
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

/** `mutate()` 回调拿到的东西 —— 想干什么都得通过它们 */
export interface FlowMutationContext {
  doc: Y.Doc
  nodes: Y.Map<Y.Map<unknown>>
  edges: Y.Map<Y.Map<unknown>>
  meta: Y.Map<unknown>
}
