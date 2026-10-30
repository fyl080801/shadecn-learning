import { computed, nextTick, ref, shallowRef, watch, watchEffect } from "vue"
import { until, useEventListener } from "@vueuse/core"
import { toast } from "vue-sonner"
import {
  getConnectedEdges,
  getRectOfNodes,
  useVueFlow,
  type Connection,
  type Edge,
  type GraphNode,
  type HandleType,
  type Node,
  type NodeChange,
  type XYPosition
} from "@vue-flow/core"
import { createId } from "@/lib/id"
import { elementKey, type PresencePoint } from "@/lib/presence"
import { buildFlowNode, flowNodeTypeOf, GROUP_NODE_TYPE, NEW_NODE_TYPE } from "@/components/flow/node-types"
import { toVueFlowNode } from "@/components/flow/node-view"
import {
  connectableNodeTypes,
  DEFAULT_EDGE_TYPE,
  interactionGate,
  resolveConnection,
  type ConnectionCandidate,
  type ConnectionContext,
  type GrowCandidate
} from "@shadecn/shared/flow-node-types"
import { groupFrameAround, planAutoLayout } from "@shadecn/shared/flow-layout"
import { FlowOpError } from "@shadecn/shared/flow-ops"
import { isEditableTarget } from "./editable"
import type { FlowPresence } from "./useFlowPresence"
import type { FlowSelection } from "./useFlowSelection"
import { useFlowSnapping } from "./useFlowSnapping"
import type { useFlowStore } from "@/stores/flow"
import { type FlowNode } from "@shadecn/shared/flow-graph"

type FlowStore = ReturnType<typeof useFlowStore>

/** 画布空白处的指针行为 */
export type FlowInteractionMode = "select" | "pan"

/**
 * 连线一律用贝塞尔曲线（Vue Flow 的 `default` 边）。
 *
 * `smoothstep` / `step` 那种折线会带直角，这里不用；新连的线存这个值，
 * 老数据里存着折线类型的边在渲染时也按这个覆盖（见 `edges`）。
 */
export const FLOW_EDGE_TYPE = DEFAULT_EDGE_TYPE

/** 连续新增时的层叠偏移，避免节点完全重叠（第一个仍然正好在中心） */
const CASCADE_STEP = 24
const CASCADE_COUNT = 6

/** 视图控件按钮触发的缩放 / 全览过渡时长（ms） */
const VIEW_TRANSITION_MS = 200

/**
 * Vue Flow、store、协同三者之间的那层胶水 —— 也是**唯一**同时认识这三者的地方。
 *
 * 职责分两半：
 * - **数据层**：把画布上的交互翻译成对 store 的调用，最终落到一个带 origin 的 Y 事务
 *   （因此才进撤销栈、才广播、才被服务端落库）；
 * - **反馈层**：把本地的选中 / 拖动 / 连线上报给 `presence`，再把别人的占用情况
 *   翻译成 Vue Flow 认得的只读标记。
 *
 * 占用（谁选中了就归谁）的规则对**节点和边完全一致**，差异只在各自多挡一样东西：
 * 节点多挡「从它连出线」，边多挡「改端点」。规则本身在 `apps/web/src/lib/presence.ts`。
 *
 * `useVueFlow()` 在这里调用（即编辑器根组件的 setup），后面渲染的 `<VueFlow>`
 * 会接管同一个实例 —— 所以工具栏、胶囊这些不在画布内部的组件也能拿到
 * `screenToFlowCoordinate` 之类的能力。
 */
export function useFlowCanvas(
  store: FlowStore,
  presence: FlowPresence,
  selection: FlowSelection
) {
  const {
    vueFlowRef,
    screenToFlowCoordinate,
    getViewport,
    setViewport,
    findNode,
    getNodes,
    getEdges,
    getSelectedNodes,
    getSelectedEdges,
    addSelectedNodes,
    addSelectedElements,
    removeSelectedNodes,
    minZoom,
    maxZoom,
    viewport,
    zoomIn,
    zoomOut,
    zoomTo,
    fitView,
    onPaneReady,
    onConnect,
    onConnectStart,
    onConnectEnd,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    selectionKeyCode,
    userSelectionActive
  } = useVueFlow()

  /**
   * 正在拉框（按下并且已经拖出了一个框）。
   *
   * 拉框期间画布上**不出现任何工具栏**：框扫过一个节点时它会短暂地成为「唯一选中」，
   * 于是节点头上的复制/删除会闪一下又消失；而选区那条（打组）在框还在变的时候
   * 也只是跟着乱跳。两者都等松手之后再说 —— 高亮实时翻转就够了，那才是拉框时要看的反馈。
   */
  const boxSelecting = computed(() => userSelectionActive.value)

  /** 拖动时的网格 / 辅助线吸附；两者都常开，没有开关 */
  const snapping = useFlowSnapping()

  /**
   * 我自己是不是正在拖节点。
   *
   * 拖动期间**必须保持 `nodes` 的数组引用不变**：Vue Flow 靠引用判断要不要重新同步节点，
   * 一旦重新同步，它会用 `Object.assign(内部那份, 传进来的这份)` 把手上正在拖的位置
   * 覆盖成 store 里那份（拖动前的）—— 节点当场弹回原地。
   *
   * 而拖动期间偏偏一定会有东西在变：我自己在往 awareness 上报拖动位置，
   * 这会触发本地的 awareness change，`presence` 的派生值跟着重算。
   * 所以这里显式把它挡住。
   */
  const localDragging = ref(false)

  /**
   * 交给 Vue Flow 渲染的数据。
   *
   * 每个投影节点经 `toVueFlowNode` 映射成 Vue Flow 的形状（layout 摊到顶层，其余四组进 `data`）。
   * 映射**按对象缓存**：store 投影里没变的节点（`createNodeProjector` 保留了引用）换回的还是
   * 上一轮那个 Vue Flow 节点对象，Vue Flow 靠引用判断，不会去碰它。只有「别人正拖着某个节点」时
   * 才需要复制一份把位置盖掉 —— 拖动松手才写进文档，不盖这一下的话，
   * 对方看到的是松手瞬间的瞬移而不是跟手移动。
   *
   * **本地拖动期间整个数组原样交回上一轮的**（`previous`）：见 `localDragging`。
   */
  const nodes = computed<Node[]>((previous) => {
    if (localDragging.value && previous) return previous

    const remote = presence.nodePositions.value

    return store.nodes.map((node) => {
      const view = toVueFlowNode(node)
      const at = remote.get(node.id)
      const holdExtent = !extentReady(node)
      if (!at && !holdExtent) return view

      return {
        ...view,
        ...(at ? { position: { ...at } } : {}),
        // 显式写 undefined，不能只是「不给这个键」：Vue Flow 合并节点用的是
        // Object.assign(它内部那份, 传进来的这份)，键不出现的话上一次那个 'parent' 会留着
        ...(holdExtent ? { extent: undefined } : {})
      }
    })
  })

  /**
   * 「不许拖出分组」这条现在能不能交给 Vue Flow —— **父节点量出尺寸了才算能**。
   *
   * Vue Flow 是拿父节点的 `dimensions` 算这个边界的，而分组框刚出现在画布上时
   * 尺寸还是 0：边界退化成一个点，每个子节点当场被夹到「父节点左上角减去自己的宽高」，
   * 一片节点全叠到框外面去 —— 文档里的坐标始终是对的，坏的只是本地视图。
   *
   * 这道门必须开在**交给 Vue Flow 之前**、而不是写文档的时候：打组的人可以等自己
   * 这边渲染完再写，收到同步的人没有这个机会 —— 他是从文档里读到 `extent` 的，
   * 读到就立刻夹。协同画布上「别人打的组，在我这儿散了一地」就是这么来的。
   * 放在这里，本地、远端、刷新走的是同一条路。
   */
  function extentReady(node: FlowNode): boolean {
    const { extent, parentNode } = node.layout
    if (extent !== "parent" || !parentNode) return true
    return (findNode(parentNode)?.dimensions.width ?? 0) > 0
  }

  /**
   * 老数据里可能存着 smoothstep 之类的折线类型，渲染时统一按曲线走。
   *
   * handle 也一律按空的交给 Vue Flow：节点的连接点都不带 id，端口在 `data` 上 ——
   * 万一哪条边存着 handle id（老数据、别的客户端），Vue Flow 找不到同 id 的 handle 会让它不渲染。
   */
  const edges = computed<Edge[]>(() =>
    store.edges.map(
      (edge) =>
        ({ ...edge, type: FLOW_EDGE_TYPE, sourceHandle: null, targetHandle: null }) as unknown as Edge
    )
  )

  /**
   * 选中态**只有一份来源：Vue Flow 自己那份**，`selection` 是它的投影。
   *
   * 各维护一份是不行的：点选走 `node-click`，而拖动一个节点也会选中它
   * （`selectNodesOnDrag`，在 dragstart 里换选中态），并且 d3-drag 会把拖动之后
   * 那次 click 吞掉 —— 于是「先点 A，再拖 B」时 Vue Flow 那份换成了 B，
   * 我们这份还停在 A，两个节点头上同时挂着工具栏。
   *
   * 投影只在**恰好选中一个节点**时有值：它代表「现在轮到哪个节点」，
   * 框选出来的一片没有「哪一个」可言。
   *
   * 用 watch 而不是某个 `onXxx` 钩子：Vue Flow 没有「选中变化」这个事件，
   * 它把选中态放在 `getSelectedNodes` 上，改选中的路子（点选 / 框选 / 拖动 /
   * 点空白）最后都汇到这里。
   */
  watch(
    getSelectedNodes,
    (selected) => selection.select(selected.length === 1 ? (selected[0]?.id ?? null) : null),
    { immediate: true }
  )

  /**
   * 拉框时，命中节点**相连的边也算选中** —— 边跟着它的端点走。
   *
   * Vue Flow 自己在拉框时也做这件事，但它拿「上一帧选中的边」和这一帧比，
   * 相等就一条变更都不发；而按下时的 `removeSelectedElements()` 只清了元素上的
   * 选中态、没清它那份缓存。于是**连着框选两次、两次命中同一条边**时，
   * 第二次算出来的集合和上一次相等，它什么都不发，那条边就一直停在「没选中」上。
   * 所以这条规则由我们自己兜底重申一遍。
   *
   * 只在拉框期间生效：点选一条边本身会把节点选中态清空，那时再按这条规则算一遍，
   * 会把刚点中的边又取消掉。
   */
  watch(getSelectedNodes, (selected) => {
    if (!boxSelecting.value) return

    const connected = getConnectedEdges(selected, getEdges.value)
    const wanted = new Set(connected.map((edge) => edge.id))
    const current = getSelectedEdges.value
    if (current.length === wanted.size && current.every((edge) => wanted.has(edge.id))) return

    // 节点也一并传进去：这个 action 是「选中态就是这些」，只给边会把节点全清掉
    addSelectedElements([...selected, ...connected])
  })

  /**
   * 只选中这一个节点，清掉其它的。
   *
   * 给**画布外的入口**用：`NodeToolbar` 是 teleport 出节点 DOM 的，点它不会冒泡成
   * `node-click`，所以双击改名、复制出新节点这类动作得自己把选中态切过去。
   */
  function selectOnly(nodeId: string) {
    const node = findNode(nodeId)
    if (!node) return
    removeSelectedNodes(getSelectedNodes.value.filter((item) => item.id !== nodeId))
    addSelectedNodes([node])
  }

  /**
   * 本地选中 → 上报。节点和边分别取自 Vue Flow 的两份选中列表，
   * 合成一份统一的元素 key 列表，反馈层不关心它们是节点还是边。
   */
  const localSelection = computed(() => {
    const keys = getSelectedNodes.value.map((node) => elementKey("node", node.id))
    for (const edge of getSelectedEdges.value) keys.push(elementKey("edge", edge.id))
    return keys
  })

  watch(localSelection, (keys) => presence.setSelection(keys), { immediate: true })

  // —— 指针模式 ——

  /** 空白处按下左键做什么：`select` 拉框选，`pan` 拖动画布 */
  const interactionMode = ref<FlowInteractionMode>("select")

  /**
   * 按住空格 = 临时拖画布，松手就回到原来的模式 —— 这是个手势，不是模式，
   * 所以不写进 `interactionMode`（工具栏上的高亮不该跟着闪）。
   *
   * Vue Flow 自带的 `panActivationKeyCode`（默认就是 Space）在这里不够用：
   * 它只放行 d3 的 filter 前半段，后面那条「`panOnDrag` 是数组且不含 0 就拒绝
   * 左键按下」照样把左键拦掉，而框选模式下 `panOnDrag` 正是 `[1]`。
   */
  const spacePanning = ref(false)

  useEventListener(window, "keydown", (event: KeyboardEvent) => {
    if (event.code !== "Space" || isEditableTarget(event.target)) return
    // 空格默认会滚页面、会「按下」当前聚焦的按钮，按住平移期间都不该发生
    event.preventDefault()
    spacePanning.value = true
  })

  useEventListener(window, "keyup", (event: KeyboardEvent) => {
    if (event.code !== "Space") return
    spacePanning.value = false
  })

  // 切走标签页收不到 keyup，回来别卡在平移状态
  useEventListener(window, "blur", () => {
    spacePanning.value = false
  })

  /**
   * 框选模式下左键留给选区，平移改用中键 —— 不然想框选就得先切模式，
   * 而中键拖画布是这类编辑器里通用的手势。
   *
   * 按住空格时给 `true`（而不是 `[0, 1]`）：Vue Flow 的 `shouldSelectOnDrag`
   * 判的是 `panOnDrag !== true`，只有布尔 true 才能把左键从框选那边要回来。
   */
  const panOnDrag = computed<boolean | number[]>(() =>
    spacePanning.value || interactionMode.value === "pan" ? true : [1]
  )

  /**
   * 空格期间节点不可拖：节点的 d3-drag 会吃掉 mousedown，不关掉的话
   * 鼠标停在节点上按下拖的还是节点，而不是画布。
   */
  const nodesDraggable = computed(() => !spacePanning.value)

  /**
   * Vue Flow 1.x 没有 `selectionOnDrag` 这个开关：它把 `selectionKeyCode === true`
   * 当成「一直处于框选状态」（内部的 shouldSelectOnDrag 就是这么判的），
   * 并且此时 `panOnDrag` 必须是不含 0 的数组，否则左键还是被平移抢走。
   *
   * 写进 store 而不是当 `<VueFlow>` 的 prop 传：该 prop 的运行时类型只声明了
   * Boolean | null，传字符串会被 Vue 判成类型不符并在控制台告警。
   * 拖动模式下退回默认的 Shift —— 按住 Shift 依然能框选。
   */
  watchEffect(() => {
    selectionKeyCode.value = interactionMode.value === "select" ? true : "Shift"
  })

  function setInteractionMode(mode: FlowInteractionMode) {
    interactionMode.value = mode
  }

  // —— 拖动 ——

  /** 拖动开始时记下原位置，拖完才合成一条 node.move（中间过程不进历史） */
  const dragOrigin = new Map<string, { x: number; y: number }>()

  /** 拖动中的位置发到反馈层，别人才看得到节点跟着手走，而不是松手时瞬移 */
  function publishDrag(dragged: GraphNode[]) {
    const geometry: Record<string, PresencePoint> = {}
    for (const node of dragged) {
      geometry[elementKey("node", node.id)] = { ...node.position }
    }
    presence.setTransform(geometry)
  }

  onNodeDragStart(({ nodes: dragged }) => {
    localDragging.value = true
    for (const node of dragged) dragOrigin.set(node.id, { ...node.position })
    // 参照物在按下这一刻量一次，拖动期间不再变
    snapping.begin(dragged)
    // 一按下就发：别人得立刻看到它归我了，不然两个人会同时搬同一个节点
    publishDrag(dragged)
  })

  // 顺序要紧：**先**吸附再上报，否则别人看到的是没吸住的那个位置
  onNodeDrag(({ nodes: dragged }) => {
    snapping.apply(dragged)
    publishDrag(dragged)
  })

  onNodeDragStop(({ nodes: dragged }) => {
    // 落点已经是最后一次 onNodeDrag 吸附过的位置，这里只需要把线收掉
    snapping.end()

    const moved = new Map<string, { x: number; y: number }>()
    for (const node of dragged) {
      const before = dragOrigin.get(node.id)
      dragOrigin.delete(node.id)
      if (!before) continue
      if (before.x === node.position.x && before.y === node.position.y) continue
      moved.set(node.id, { ...node.position })
    }

    // 顺序要紧：**先**把落定的位置作为数据发出去，**再**收掉拖动中的临时几何。
    // 反过来的话对方会先失去临时位置、退回旧坐标，等数据到了再跳一下 —— 看着就是闪一下。
    // 先解冻再提交：提交会换掉 store.nodes，这时正需要 Vue Flow 同步到新位置
    localDragging.value = false

    if (moved.size > 0) {
      // 一次拖动 = 一条撤销（框选一起拖也算一条）
      store.separateUndo()
      store.moveNodes(moved, moved.size > 1 ? `移动 ${moved.size} 个节点` : "移动节点")
      store.separateUndo()
    }
    presence.clearTransform()
  })

  /**
   * 拖动过程中 Vue Flow 会不断派发 position 变化。
   *
   * 这些中间态**不写进 Y.Doc**：写了就会广播 + 落库 + 进撤销栈，一次拖动能产生几十条。
   * 拖动期间画面由 Vue Flow 自己的内部状态负责，落定的位置在 `onNodeDragStop` 一次性提交；
   * 中间态要给别人看，走的是反馈层（awareness），不是数据层。
   */
  function onNodesChange(_changes: NodeChange[]) {
    // 有意留空：位置的唯一写入点是 onNodeDragStop
  }

  // —— 连线 ——

  /**
   * 拉线过程也要让别人看见。只上报**起点**：线的另一头就是我的光标，
   * 而光标本来就在发，没必要发两遍。
   *
   * 起点从 Vue Flow 量出来的连接口位置算：`handleBounds` 是相对节点的，
   * 加上节点的 `computedPosition` 才是画布坐标 —— 对方拿到就能直接画。
   */
  onConnectStart(({ nodeId, handleId, handleType }) => {
    if (!nodeId) return
    connectStart = { nodeId, handleType: handleType === "target" ? "target" : "source" }
    connectedThisDrag = false
    const node = findNode(nodeId)
    if (!node) return

    const bounds = node.handleBounds[handleType === "target" ? "target" : "source"] ?? []
    const handle = bounds.find((item) => item.id === handleId) ?? bounds[0]
    if (!handle) return

    presence.setConnecting({
      from: {
        x: node.computedPosition.x + handle.x + handle.width / 2,
        y: node.computedPosition.y + handle.y + handle.height / 2
      },
      // 拉线期间起点节点算我在编辑，别人不能同时删它、搬它
      nodeId
    })
  })

  /**
   * 这一次拉线从哪个连接点出发、有没有真的连上 —— 松手时用来判断落点：
   * 落在节点身上就连到它（`connectNodes`），拉到空白处就在落点弹出新建节点的菜单（`openGrowMenu`）。
   */
  let connectStart: { nodeId: string; handleType: HandleType } | null = null
  let connectedThisDrag = false

  // 松手就收线，无论连上没连上
  onConnectEnd((event) => {
    presence.setConnecting(null)

    const start = connectStart
    connectStart = null
    // Vue Flow 先发 connect 再发 connectEnd：连上了（含靠近吸附上的）就不再建节点
    if (!start || connectedThisDrag || !event) return

    // 线只能从出口拉（入口 `connectable-start=false`）；万一从入口起了拉，也不往回长
    if (start.handleType !== "source") return

    const point = "changedTouches" in event ? event.changedTouches[0] : event
    if (!point) return
    const drop = dropTargetAt(point)
    if (drop.kind === "node") {
      // 落在节点身上（没对准左边的入口）也算连到它：端口照样由 `resolveConnection` 选，连不上就提示原因
      if (drop.nodeId !== start.nodeId) connectNodes(start.nodeId, drop.nodeId)
      return
    }
    if (drop.kind === "pane") {
      openGrowMenu(start.nodeId, { drop: { clientX: point.clientX, clientY: point.clientY } })
    }
  })

  /**
   * 落点下面是什么。看的是**落点下面的元素**，不依赖 `event.target` 指向谁：
   * - `node`：某个节点身上（Vue Flow 节点根元素的 `data-id`）；
   * - `pane`：空白画布；
   * - `none`：画布外，或浮在画布上的控件（缩放按钮、小地图、节点工具栏）。
   */
  function dropTargetAt(point: {
    clientX: number
    clientY: number
  }): { kind: "node"; nodeId: string } | { kind: "pane" } | { kind: "none" } {
    const element = document.elementFromPoint(point.clientX, point.clientY)
    if (!element || !vueFlowRef.value?.contains(element)) return { kind: "none" }
    if (element.closest(".vue-flow__panel, .vue-flow__node-toolbar")) return { kind: "none" }
    const nodeId = element.closest(".vue-flow__node")?.getAttribute("data-id")
    if (nodeId) return { kind: "node", nodeId }
    return { kind: "pane" }
  }

  /** 校验时节点的类型从 store 查（文档的投影），不从 Vue Flow 那份查 */
  function typeOfNode(id: string): string | undefined {
    return store.nodeById.get(id)?.type
  }

  /**
   * 喂给 shared 连线规则的画布：类型、业务 data（交互门看形态：asset 的图片 / 视频不接受拖线）、已有的边。
   * 拉线途中的校验和候选菜单从投影读；真正建边时 `@shadecn/shared/flow-ops` 从文档拼同样三样
   * （`docConnectionContext`，agent 也用它），口径一致。
   */
  function connectionContext(): ConnectionContext {
    return {
      typeOf: typeOfNode,
      dataOf: (id) => store.nodeById.get(id)?.data,
      edges: store.edges
    }
  }

  /**
   * 人拖的这条线能不能连、连哪对端口；不能连给出原因。先过交互门（asset 形态的图片 / 视频不接受拖进来的线，
   * shared 的 `interactionGate`），再按 shared 的 `resolveConnection` 选端口。
   */
  function resolve(candidate: ConnectionCandidate) {
    const context = connectionContext()
    const gate = interactionGate(candidate, context)
    if (!gate.ok) return gate
    return resolveConnection(candidate, context)
  }

  /**
   * 拉线时这条线能不能连 —— 挂在 `Handle` 的 `is-valid-connection` 上（理由见
   * `FlowNodeHandles.vue`）。Vue Flow 给的 handle id 一律忽略（连接点不带 id），端口由
   * `resolveConnection` 自动选：按声明顺序找第一对数据类型兼容、目标端口没满、还没连过的，
   * 找不到就不让连。agent 的 connect 用的是同一个函数。
   */
  function isValidConnection(connection: Connection): boolean {
    return resolve({ source: connection.source, target: connection.target }).ok
  }

  onConnect((connection: Connection) => {
    connectedThisDrag = true
    connectNodes(connection.source, connection.target)
  })

  /**
   * 松手真正建边（落在入口上、或落在节点身上）。这一刻再选一次端口：拉线期间别人可能已经占掉了那个端口。
   * 先问交互门（落在 asset 节点身上也一样被拒）；选端口、建边在 `store.connect`（→ `ops.connect`，逻辑门）里，
   * 连不上它抛 `FlowOpError`，这里提示原因。
   */
  function connectNodes(source: string, target: string) {
    const gate = interactionGate({ target }, connectionContext())
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    try {
      store.connect(source, target)
    } catch (error) {
      if (!(error instanceof FlowOpError)) throw error
      toast.error(error.message)
    }
  }

  // —— 视口 ——

  /**
   * 视口是**视图状态**：不进历史、不产生操作、不涨 revision —— 各人看各人的。
   * 这里只是把值交给 store 攒着，**不会发请求**：它搭下一次本地编辑
   * （或离开页面）的车落库，平移缩放本身不该产生写流量。
   */
  function syncViewport() {
    store.setViewport(getViewport())
  }

  onPaneReady(() => {
    // 我自己存过视口就照原样恢复，哪怕它正好等于默认值
    if (store.userState.viewport) {
      setViewport(store.viewport)
      return
    }

    // 没存过的话，此刻（内容已同步到位）才读得到快照里的兜底视口 ——
    // attachDoc 那会儿文档还是空壳，在那里读永远落空
    store.applyFallbackViewport()

    const { x, y, zoom } = store.viewport
    // 快照里那份兜底视口非默认值就用它；否则 fitView（且不放大超过 1 倍，
    // 否则 Vue Flow 默认会放到 4 倍，节点大得离谱）
    if (store.nodes.length > 0 && (x !== 0 || y !== 0 || zoom !== 1)) {
      setViewport(store.viewport)
      syncViewport()
    } else {
      fitView({ maxZoom: 1, padding: 0.2 })
      syncViewport()
    }
  })

  /**
   * 滚轮平移、Ctrl + 滚轮以光标为锚点缩放（手感沿用 REQ-FLOW）。
   *
   * 缩放自己实现：d3 的 wheelDelta 见到 ctrlKey 会把 delta ×10（那是给触控板
   * 捏合用的），鼠标滚轮一格 deltaY=120 会一下顶到上下限。
   */
  function onWheelZoom(event: WheelEvent) {
    if (!event.ctrlKey) return

    // 拦在捕获阶段，Vue Flow 自己的 wheel 处理就收不到这个事件了
    event.preventDefault()
    event.stopPropagation()

    const { x, y, zoom } = getViewport()
    const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002)
    const nextZoom = Math.min(maxZoom.value, Math.max(minZoom.value, zoom * 2 ** delta))
    if (nextZoom === zoom) return

    const point = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
    setViewport({
      x: x - point.x * (nextZoom - zoom),
      y: y - point.y * (nextZoom - zoom),
      zoom: nextZoom
    })
    syncViewport()
  }

  // —— 视图控件（右下角那组）——

  /**
   * 按钮触发的缩放 / 适应视图。
   *
   * 和手势不同，程序调用不会发 `move-end`（d3 只对带 sourceEvent 的那次 `end` 发事件），
   * 所以等过渡结束后自己同步一次视口，否则刷新回来还是旧的。
   */
  async function afterTransition(transition: Promise<boolean>) {
    await transition
    syncViewport()
  }

  /** 当前缩放比（1 = 100%），给百分比输入框显示用 */
  const zoomLevel = computed(() => viewport.value.zoom)

  function zoomInView() {
    return afterTransition(zoomIn({ duration: VIEW_TRANSITION_MS }))
  }

  function zoomOutView() {
    return afterTransition(zoomOut({ duration: VIEW_TRANSITION_MS }))
  }

  /** 缩放到指定比例（1 = 100%），夹在 min / max 之间；非法值直接忽略 */
  function zoomToLevel(level: number) {
    if (!Number.isFinite(level) || level <= 0) return Promise.resolve()
    const clamped = Math.min(maxZoom.value, Math.max(minZoom.value, level))
    return afterTransition(zoomTo(clamped, { duration: VIEW_TRANSITION_MS }))
  }

  /** 全览：和首次打开的兜底一致，不放大超过 1 倍 */
  function fitAll() {
    return afterTransition(fitView({ maxZoom: 1, padding: 0.2, duration: VIEW_TRANSITION_MS }))
  }

  // —— 自动布局 ——

  /** 画布上有没有东西可排；空画布时按钮置灰 */
  const canAutoLayout = computed(() => store.nodes.length > 0)

  /**
   * 横向自动布局（从左到右，dagre），排完全览一次。
   *
   * 只排**顶层**节点：分组框连同里面的节点当成一个盒子整体挪（子节点的坐标相对分组，不用动）；
   * 连到组内节点的线按它所在的顶层分组计 —— 这些规则在 shared 的 `planAutoLayout`（agent 的
   * `ops.autoLayout` 也走它）；这里只把尺寸换成 Vue Flow 实测的 `dimensions`。
   *
   * 是一次内容修改：所有位置一笔 `moveNodes` 写进文档 = 一条撤销，照常广播给协作者。
   * 本地正拖着节点时不排（拖完那次提交会把位置覆盖回去）。
   */
  async function autoLayout() {
    if (localDragging.value) return

    if (!getNodes.value.some((node) => !node.parentNode)) return

    const moved = planAutoLayout(
      getNodes.value.map((node) => ({
        id: node.id,
        parentNode: node.parentNode,
        position: node.position,
        width: node.dimensions.width,
        height: node.dimensions.height
      })),
      getEdges.value.map((edge) => ({ source: edge.source, target: edge.target }))
    )

    if (moved.size > 0) {
      store.separateUndo()
      store.moveNodes(moved, "自动布局")
      store.separateUndo()
    }

    // 新位置要等 Vue Flow 同步到内部节点后再量外接矩形
    await nextTick()
    await fitAll()
  }

  /** 小地图显隐 —— 纯本地视图偏好，不进文档也不落库；默认不显示 */
  const miniMapVisible = ref(false)

  // —— 删除 ——

  /**
   * 删除选中的元素（节点 + 边）。**画布上唯一的删除入口。**
   *
   * Vue Flow 自带的 `deleteKeyCode` 必须关掉（`FlowCanvas.vue` 传 `:delete-key-code="null"`）：
   * 它在 `applyDefault` 下直接改自己内部那份 nodes/edges，绕过 store ——
   * 于是本地看着删掉了，store 不知情，既不进历史、不落库，也不会广播给别人。
   * 「删了一条线，刷新又回来了 / 对面还看得见」就是这么来的。
   *
   */
  function deleteSelection() {
    const nodeIds = new Set<string>(getSelectedNodes.value.map((node) => node.id))
    const edgeIds = new Set<string>(getSelectedEdges.value.map((edge) => edge.id))

    if (nodeIds.size === 0 && edgeIds.size === 0) return

    // 连着的边由 store 一并处理（留下悬空的边等于界面上没了、数据里还在）
    store.separateUndo()
    store.removeElements(nodeIds, edgeIds)
    store.separateUndo()
    selection.clearSelection()
  }

  /**
   * 删掉指定的一个节点（节点工具栏上的删除按钮）。
   *
   * 和 `deleteSelection()` 的区别只在作用对象：这里删的是按钮所在的那个节点，
   * 不管当前还框选着别的什么。连着的边照样由 store 一并清掉。
   */
  function deleteNode(nodeId: string) {
    store.separateUndo()
    store.removeElements([nodeId], [])
    store.separateUndo()
    if (selection.selectedNodeId.value === nodeId) selection.clearSelection()
  }

  // —— 复制节点 ——

  /**
   * 复制一个节点，错开一点放。复制什么（运行态重置为空闲、不带产出，连线一条都不复制，深拷贝）
   * 由 `ops.duplicateNode` 定；这里只管撤销分段和选中。
   */
  async function duplicateNode(nodeId: string): Promise<string | null> {
    if (!store.nodeById.has(nodeId)) return null

    const id = createId("n")
    // 「复制」是一个独立的动作，别和刚才那次编辑并成同一条撤销
    store.separateUndo()
    store.duplicateNode(nodeId, { id, offset: { x: CASCADE_STEP, y: CASCADE_STEP } })
    store.separateUndo()

    // 选中复本：接着就能拖走或改名，符合复制完的下一步意图。
    // 复本要等一帧才渲染出来，selectOnly 里的 findNode 之前必须 nextTick。
    await nextTick()
    selectOnly(id)
    return id
  }

  // —— 在场（光标） ——

  /**
   * 把鼠标位置换算成**画布坐标**再上报：各人的视口不一样，
   * 屏幕坐标发过去对方根本对不上位置。节流在 presence 那边做。
   */
  function onPointerMove(event: PointerEvent) {
    presence.setCursor(screenToFlowCoordinate({ x: event.clientX, y: event.clientY }))
  }

  /** 鼠标移出画布就把光标收掉，别在对方屏幕上留一个不动的箭头 */
  function onPointerLeave() {
    presence.setCursor(null)
  }

  // —— 新增节点 ——

  let cascadeIndex = 0

  /**
   * 在画布中心加一个节点，返回它的 id（画布还没挂载好时返回 null）。
   *
   * 长什么样由**节点类型注册表**说了算（`apps/web/src/components/flow/node-types.ts`）——
   * 这里不认识任何具体类型，加一种节点不用改这个函数。
   */
  async function addNode(type: string = NEW_NODE_TYPE): Promise<string | null> {
    const bounds = vueFlowRef.value?.getBoundingClientRect()
    if (!bounds) return null

    const id = createId("n")
    const offset = (cascadeIndex++ % CASCADE_COUNT) * CASCADE_STEP
    const center = screenToFlowCoordinate({
      x: bounds.left + bounds.width / 2 + offset,
      y: bounds.top + bounds.height / 2 + offset
    })

    const node = buildFlowNode({
      id,
      type,
      position: center,
      label: `${flowNodeTypeOf(type).label} ${store.nodes.length + 1}`
    })
    // 连点两次「添加节点」应该是两条撤销，不是一条
    store.separateUndo()
    store.addNode(node)

    // position 是左上角，要等渲染量出尺寸后才能真正居中
    const rendered = findNode(id)
    if (!rendered) return id
    await until(() => rendered.dimensions.width).toBeTruthy({ timeout: 1000 })

    // 居中是「新增」的一部分，跟它并进同一条撤销 —— 中间不 separateUndo
    store.moveNodes(
      new Map([
        [
          id,
          {
            x: center.x - rendered.dimensions.width / 2,
            y: center.y - rendered.dimensions.height / 2
          }
        ]
      ]),
      "居中新节点"
    )
    store.separateUndo()

    return id
  }

  /** 点出口上的加号时，新节点和原节点之间留的空隙（画布坐标） */
  const CONNECTED_NODE_GAP = 80

  /**
   * 「从出口长出新节点」的候选菜单（`FlowGrowMenu.vue` 画它）。
   *
   * 两个入口弹同一个菜单：点出口上的加号（锚在那个连接点上），拉线到空白处松手（锚在落点）。
   * 菜单里只列 shared 的 `connectableNodeTypes` 认可的类型 —— 按「全新的空节点」去试 `resolveConnection`，
   * 和真连线是同一套规则；选一种才建节点。Esc / 点别处关掉，什么都不建。
   */
  interface GrowMenuState {
    /** 从哪个节点的出口长 */
    sourceId: string
    /** 新节点入口（左边中点）落在哪（画布坐标） */
    at: XYPosition
    /** 菜单贴着谁：连接点元素，或松手那一点（reka-ui 的虚拟参照元素） */
    reference: { getBoundingClientRect: () => DOMRect }
  }

  const growMenu = shallowRef<GrowMenuState | null>(null)

  /** 菜单里此刻该列哪些类型：随画布变（别人在这期间往这里连了线、改了形态）而变 */
  const growCandidates = computed<GrowCandidate[]>(() => {
    const menu = growMenu.value
    return menu ? connectableNodeTypes(menu.sourceId, connectionContext()) : []
  })

  /**
   * 弹出候选菜单。`anchor`：点加号时那个连接点元素（新节点放在原节点右边隔一段）；
   * `drop`：拉线松手的屏幕坐标（新节点的入口落在那一点）。
   */
  function openGrowMenu(
    sourceId: string,
    place: { anchor: Element } | { drop: { clientX: number; clientY: number } }
  ) {
    const from = findNode(sourceId)
    if (!from) return
    if ("drop" in place) {
      const { clientX, clientY } = place.drop
      growMenu.value = {
        sourceId,
        at: screenToFlowCoordinate({ x: clientX, y: clientY }),
        reference: { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) }
      }
      return
    }
    growMenu.value = {
      sourceId,
      at: {
        x: from.computedPosition.x + from.dimensions.width + CONNECTED_NODE_GAP,
        y: from.computedPosition.y + from.dimensions.height / 2
      },
      reference: place.anchor
    }
  }

  function closeGrowMenu() {
    growMenu.value = null
  }

  /** 在菜单里选了一种：关菜单，按菜单记下的位置长出这种节点 */
  async function growFromMenu(type: string): Promise<string | null> {
    const menu = growMenu.value
    if (!menu) return null
    growMenu.value = null
    return addConnectedNode(menu.sourceId, type, menu.at)
  }

  /**
   * 从 `sourceId` 的出口长出一个 `type` 节点并连上，新节点的入口（左边中点）落在 `at`。
   *
   * 连哪对端口由 `store.addConnectedNode`（→ `ops.createConnectedNode`）按新节点的数据定（全新的空节点，
   * 规则就是 `resolveConnection`）；菜单弹出之后画布可能变了，连不上就提示原因、不建节点 ——
   * 不该凭空多出一个没连上的节点。
   *
   * 节点和线进**同一个事务**：一条撤销把两者一起拿掉，别人也不会先看到一条指向不存在节点的线。
   * 摆正位置要等量出尺寸，和 `addNode` 一样并进同一条撤销（中间不 `separateUndo`）。
   */
  async function addConnectedNode(sourceId: string, type: string, at: XYPosition): Promise<string | null> {
    if (typeOfNode(sourceId) === undefined) return null
    const place = (height: number) => ({ x: at.x, y: at.y - height / 2 })

    const id = createId("n")
    const node = buildFlowNode({
      id,
      type,
      position: place(0),
      label: `${flowNodeTypeOf(type).label} ${store.nodes.length + 1}`
    })

    store.separateUndo()
    try {
      store.addConnectedNode(node, { source: sourceId })
    } catch (error) {
      if (!(error instanceof FlowOpError)) throw error
      toast.error(error.message)
      return null
    }

    const rendered = findNode(id)
    if (rendered) {
      await until(() => rendered.dimensions.width).toBeTruthy({ timeout: 1000 })
      store.moveNodes(new Map([[id, place(rendered.dimensions.height)]]), "摆放新节点")
      selectOnly(id)
    }
    store.separateUndo()

    return id
  }

  // —— 打组 ——

  /** 当前选中的节点 id（顺序同 Vue Flow 那份选中态），选区工具栏靠它定位 */
  const selectedNodeIds = computed(() => getSelectedNodes.value.map((node) => node.id))

  /**
   * 这次选中里**能被圈进一个新分组**的那些。
   *
   * 两种挡在外面：已经在别的分组里的（换爹会把它从原来的框里抠出来，
   * 而它在画面上明明还在那个框里），以及分组框自己（嵌套分组的层级和坐标
   * 都要另说一套，现在不做）。
   */
  const groupableNodes = computed(() =>
    getSelectedNodes.value.filter((node) => node.type !== GROUP_NODE_TYPE && !node.parentNode)
  )

  /** 至少两个才谈得上「一组」；一个节点的分组框没有意义 */
  const canGroupSelection = computed(() => groupableNodes.value.length >= 2)

  /**
   * 把选中的节点圈进一个新建的分组框，返回它的 id。
   *
   * 分组是**围着已经选好的一片节点长出来的**，所以入口在框选后浮出的选区工具栏，
   * 而不是底部工具栏上的「添加分组」—— 先凭空建一个空框、再把节点一个个拖进去，
   * 顺序是反的（而且「拖进分组自动归属」还没做，那条路根本走不通）。
   *
   * 坐标要换算：挂上 `parentNode` 之后 `position` 由 Vue Flow 按**相对父节点**解释，
   * 不减去分组框的位置的话，整片节点会按原来的绝对坐标再往框的位置上加一遍，
   * 一起飞到右下角去。
   */
  async function groupSelection(): Promise<string | null> {
    const members = groupableNodes.value
    if (members.length < 2) return null

    // 外接矩形按 computedPosition + 实测尺寸算（Vue Flow 自己的工具函数），
    // 拿 store 里的 position 手算的话，没写过 width/height 的节点量不出高矮。
    // 留白（GROUP_PADDING / GROUP_HEADER）是 shared 的同一套，agent 打组也用它
    const frame = groupFrameAround(getRectOfNodes(members))
    const position = { x: frame.x, y: frame.y }

    const id = createId("n")
    const group = buildFlowNode({
      id,
      type: GROUP_NODE_TYPE,
      position,
      label: `分组 ${store.nodes.filter((node) => node.type === GROUP_NODE_TYPE).length + 1}`
    })
    // 注册表给的是默认尺寸和层级，这里只把尺寸换成刚好罩住这片节点的大小
    group.layout.width = frame.width
    group.layout.height = frame.height

    const children = new Map(
      members.map((node) => [
        node.id,
        {
          x: node.computedPosition.x - position.x,
          y: node.computedPosition.y - position.y
        }
      ])
    )

    // 打组是一个独立的动作，别和刚才那次拖动并进同一条撤销
    store.separateUndo()
    store.groupNodes(group, children)
    store.separateUndo()

    // 选中新建的分组：接着就能拖走、改名或再删掉（删分组只删框，组内节点留下）。
    // 分组要等一帧才渲染出来，selectOnly 里的 findNode 之前必须 nextTick。
    await nextTick()
    selectOnly(id)
    return id
  }

  return {
    nodes,
    edges,
    snapping,
    interactionMode,
    boxSelecting,
    spacePanning,
    panOnDrag,
    nodesDraggable,
    setInteractionMode,
    onNodesChange,
    onWheelZoom,
    zoomLevel,
    minZoom,
    maxZoom,
    zoomInView,
    zoomOutView,
    zoomToLevel,
    fitAll,
    canAutoLayout,
    autoLayout,
    miniMapVisible,
    onPointerMove,
    onPointerLeave,
    syncViewport,
    selectOnly,
    selectedNodeIds,
    canGroupSelection,
    groupSelection,
    addNode,
    addConnectedNode,
    growMenu,
    growCandidates,
    openGrowMenu,
    closeGrowMenu,
    growFromMenu,
    isValidConnection,
    duplicateNode,
    deleteNode,
    deleteSelection
  }
}

export type FlowCanvas = ReturnType<typeof useFlowCanvas>
