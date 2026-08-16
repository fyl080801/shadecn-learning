import { computed, ref, watch, watchEffect } from "vue"
import { until, useEventListener } from "@vueuse/core"
import {
  useVueFlow,
  type Connection,
  type Edge,
  type GraphNode,
  type Node,
  type NodeChange
} from "@vue-flow/core"
import { createId } from "@/lib/id"
import { elementKey, type PresencePoint } from "@/lib/presence"
import { isEditableTarget } from "./editable"
import type { FlowPresence } from "./useFlowPresence"
import type { FlowSelection } from "./useFlowSelection"
import type { useFlowStore } from "@/stores/flow"
import { defaultNodeData, type FlowEdge, type FlowNode } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/** 画布空白处的指针行为 */
export type FlowInteractionMode = "select" | "pan"

/**
 * 连线一律用贝塞尔曲线（Vue Flow 的 `default` 边）。
 *
 * `smoothstep` / `step` 那种折线会带直角，这里不用；新连的线存这个值，
 * 老数据里存着折线类型的边在渲染时也按这个覆盖（见 `edges`）。
 */
export const FLOW_EDGE_TYPE = "default"

/** 连续新增时的层叠偏移，避免节点完全重叠（第一个仍然正好在中心） */
const CASCADE_STEP = 24
const CASCADE_COUNT = 6

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
 * 节点多挡「从它连出线」，边多挡「改端点」。规则本身在 `src/lib/presence.ts`。
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
    getSelectedNodes,
    getSelectedEdges,
    minZoom,
    maxZoom,
    fitView,
    onPaneReady,
    onConnect,
    onConnectStart,
    onConnectEnd,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    selectionKeyCode
  } = useVueFlow()

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
   * 尽量**原样透传** `store.nodes`：它是 Y.Doc 的投影，只在文档真的变了时才换新数组，
   * 引用稳定，Vue Flow 就不会做多余的同步。只有「别人正拖着某个节点」时才需要
   * 复制一份把位置盖掉 —— 拖动松手才写进文档，不盖这一下的话，
   * 对方看到的是松手瞬间的瞬移而不是跟手移动。
   */
  const nodes = computed<Node[]>(() => {
    const source = store.nodes as unknown as Node[]
    if (localDragging.value) return source

    const remote = presence.nodePositions.value
    if (remote.size === 0) return source

    return source.map((node) => {
      const at = remote.get(node.id)
      return at ? ({ ...node, position: { ...at } } as unknown as Node) : node
    })
  })

  /** 老数据里可能存着 smoothstep 之类的折线类型，渲染时统一按曲线走 */
  const edges = computed<Edge[]>(() =>
    store.edges.map((edge) => ({ ...edge, type: FLOW_EDGE_TYPE }) as unknown as Edge)
  )

  /**
   * 本地选中 → 上报。
   *
   * 选中态有两个来源：节点走我们自己的 `selection`（属性面板要用），
   * 边走 Vue Flow 内部的选中态（我们没有单独的边选中态）。
   * 这里把两者合成一份统一的元素 key 列表，反馈层不关心它们从哪来。
   */
  const localSelection = computed(() => {
    const keys: string[] = []
    const nodeId = selection.selectedNodeId.value
    if (nodeId) keys.push(elementKey("node", nodeId))
    for (const node of getSelectedNodes.value) {
      const key = elementKey("node", node.id)
      if (!keys.includes(key)) keys.push(key)
    }
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
    // 一按下就发：别人得立刻看到它归我了，不然两个人会同时搬同一个节点
    publishDrag(dragged)
  })

  onNodeDrag(({ nodes: dragged }) => publishDrag(dragged))

  onNodeDragStop(({ nodes: dragged }) => {
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

  // 松手就收线，无论连上没连上
  onConnectEnd(() => presence.setConnecting(null))

  onConnect((connection: Connection) => {
    const id = createId("e")
    const edge: FlowEdge = {
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? null,
      targetHandle: connection.targetHandle ?? null,
      type: FLOW_EDGE_TYPE,
      animated: false,
      data: { config: {} }
    }
    store.addEdge(edge)
  })

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
    const nodeIds = new Set<string>()
    const selectedNodeId = selection.selectedNodeId.value
    if (selectedNodeId) nodeIds.add(selectedNodeId)
    for (const node of getSelectedNodes.value) nodeIds.add(node.id)

    const edgeIds = new Set<string>(getSelectedEdges.value.map((edge) => edge.id))

    if (nodeIds.size === 0 && edgeIds.size === 0) return

    // 连着的边由 store 一并处理（留下悬空的边等于界面上没了、数据里还在）
    store.separateUndo()
    store.removeElements(nodeIds, edgeIds)
    store.separateUndo()
    selection.clearSelection()
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

  /** 在画布中心加一个节点，返回它的 id（画布还没挂载好时返回 null） */
  async function addNode(): Promise<string | null> {
    const bounds = vueFlowRef.value?.getBoundingClientRect()
    if (!bounds) return null

    const id = createId("n")
    const offset = (cascadeIndex++ % CASCADE_COUNT) * CASCADE_STEP
    const center = screenToFlowCoordinate({
      x: bounds.left + bounds.width / 2 + offset,
      y: bounds.top + bounds.height / 2 + offset
    })

    const node: FlowNode = {
      id,
      type: "process",
      position: center,
      data: defaultNodeData(`节点 ${store.nodes.length + 1}`)
    }
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

  return {
    nodes,
    edges,
    interactionMode,
    spacePanning,
    panOnDrag,
    nodesDraggable,
    setInteractionMode,
    onNodesChange,
    onWheelZoom,
    onPointerMove,
    onPointerLeave,
    syncViewport,
    addNode,
    deleteSelection
  }
}

export type FlowCanvas = ReturnType<typeof useFlowCanvas>
