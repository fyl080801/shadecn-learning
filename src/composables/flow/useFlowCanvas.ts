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
import { defaultNodeData, type FlowEdge, type FlowNode, type FlowOp } from "@/types/flow"

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
 * - **数据层**：把画布上的交互翻译成 `FlowOp` 交给 `store.apply`（进历史、落库、广播）；
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
    removeSelectedNodes,
    removeSelectedEdges,
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
   * 交给 Vue Flow 渲染的数据，在 store 的基础上叠两层协同状态：
   *
   * 1. **被别人占住的节点变只读** —— `draggable` / `selectable` 每次都**显式写**，
   *    true 和 false 都写。Vue Flow 同步节点用的是
   *    `Object.assign(内部那份, 传进来的这份)`，是就地合并：某一次不带这两个键，
   *    上次写的 `false` 就永远留在它内部那份节点上，占用解除后节点从此点不动。
   * 2. **别人正拖着的节点用他上报的实时位置** —— 拖动松手才会产生 `node.move`，
   *    不盖这一下的话，对方看到的是松手瞬间的瞬移而不是跟手移动。
   */
  /**
   * 实际生效的占用 = 反馈层直接上报的，**加上由图结构派生的**。
   *
   * 派生的那部分只有一条规则：**占住一个节点，就等于占住了连到它的所有边**。
   * 因为「断开一条接在它上面的线」改的就是这个节点的连接关系 —— 别人正在编辑它的时候
   * 不该被人从旁边把线拆了。反过来，往它身上**新接**一条线是允许的（那是条新的边，
   * 节点本身没变），所以这里只锁已有的边，不挡新连线。
   *
   * 派生逻辑放在这一层而不是 `lib/presence.ts`：那边是纯 presence 逻辑，不认识图；
   * 「谁连着谁」只有画布知道。
   */
  const lockedKeys = computed(() => {
    const direct = presence.lockedKeys.value
    if (direct.size === 0) return direct

    const keys = new Set(direct)
    for (const edge of store.edges) {
      if (keys.has(elementKey("edge", edge.id))) continue
      if (
        direct.has(elementKey("node", edge.source)) ||
        direct.has(elementKey("node", edge.target))
      ) {
        keys.add(elementKey("edge", edge.id))
      }
    }
    return keys
  })

  /** 这个元素被别人占着吗（含派生占用）—— 画布上所有只读判断的唯一出口 */
  function isLocked(kind: "node" | "edge", id: string): boolean {
    return lockedKeys.value.has(elementKey(kind, id))
  }

  const nodes = computed<Node[]>(() => {
    const locked = lockedKeys.value
    const dragging = presence.nodePositions.value

    return store.nodes.map((node) => {
      const isLocked = locked.has(elementKey("node", node.id))
      const remote = dragging.get(node.id)
      return {
        ...node,
        position: remote ?? node.position,
        draggable: !isLocked,
        selectable: !isLocked
      } as unknown as Node
    })
  })

  /**
   * 边和节点走同一套占用规则，只是各自能关的开关不同：
   * `selectable` 挡选中，`updatable` 挡拖端点，`class` 给它画上占用配色。
   */
  const edges = computed<Edge[]>(() => {
    const locked = lockedKeys.value

    return store.edges.map((edge) => {
      const isLocked = locked.has(elementKey("edge", edge.id))
      return {
        ...edge,
        // 老数据里可能存着 smoothstep 之类的折线类型，渲染时统一按曲线走
        type: FLOW_EDGE_TYPE,
        selectable: !isLocked,
        updatable: !isLocked,
        class: isLocked ? "flow-edge-locked" : ""
      } as unknown as Edge
    })
  })

  /**
   * 占用一旦生效，把**已经**选中的也摘掉。
   *
   * `selectable: false` 只挡「接下来还能不能选中」，挡不住「已经选中的」——
   * 我先点了它、随后被 clientId 更小的人抢走，那份选中态会一直亮着，
   * 属性面板也还开着一个我已经改不动的节点。
   */
  watch(
    lockedKeys,
    (locked) => {
      if (locked.size === 0) return

      const staleNodes = getSelectedNodes.value.filter((node) =>
        locked.has(elementKey("node", node.id))
      )
      if (staleNodes.length > 0) removeSelectedNodes(staleNodes)

      const staleEdges = getSelectedEdges.value.filter((edge) =>
        locked.has(elementKey("edge", edge.id))
      )
      if (staleEdges.length > 0) removeSelectedEdges(staleEdges)

      const mine = selection.selectedNodeId.value
      if (mine && locked.has(elementKey("node", mine))) selection.clearSelection()
    }
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
    for (const node of dragged) dragOrigin.set(node.id, { ...node.position })
    // 一按下就发：别人得立刻看到它归我了，不然两个人会同时搬同一个节点
    publishDrag(dragged)
  })

  onNodeDrag(({ nodes: dragged }) => publishDrag(dragged))

  onNodeDragStop(({ nodes: dragged }) => {
    const ops: FlowOp[] = []
    for (const node of dragged) {
      const before = dragOrigin.get(node.id)
      dragOrigin.delete(node.id)
      if (!before) continue
      if (before.x === node.position.x && before.y === node.position.y) continue

      ops.push({
        type: "node.move",
        targetId: node.id,
        before: { position: before },
        after: { position: { ...node.position } }
      })
    }

    // 顺序要紧：**先**把落定的位置作为数据发出去，**再**收掉拖动中的临时几何。
    // 反过来的话对方会先失去临时位置、退回旧坐标，等操作到了再跳一下 —— 看着就是闪一下。
    // 框选一起拖 = 一条撤销
    if (ops.length > 0) {
      store.apply(ops, ops.length > 1 ? `移动 ${ops.length} 个节点` : "移动节点")
    }
    presence.clearTransform()
  })

  /**
   * Vue Flow 自己会改 position（拖动过程中），这些中间态不能进历史。
   * 这里只把它同步进 store 的状态，不产生操作。
   */
  function onNodesChange(changes: NodeChange[]) {
    for (const change of changes) {
      if (change.type !== "position" || !change.position) continue
      const node = store.nodes.find((item) => item.id === change.id)
      if (node) node.position = { ...change.position }
    }
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
    store.apply([{ type: "edge.add", targetId: id, before: null, after: edge }], "连线")
  })

  // —— 视口 ——

  /**
   * 视口是**视图状态**：不进历史、不产生操作、不涨 revision，
   * 由 store 走「按用户存」那条路防抖落库 —— 各人看各人的。
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
   * 它在 `applyDefault` 下直接改自己内部那份 nodes/edges，绕过 `store.apply` ——
   * 于是本地看着删掉了，store 不知情，既不进历史、不落库，也不会广播给别人。
   * 「删了一条线，刷新又回来了 / 对面还看得见」就是这么来的。
   *
   * 被别人占住的元素跳过：占用的一致规则是不能选、不能拖、**也不能删**。
   */
  function deleteSelection() {
    const nodeIds = new Set<string>()
    const selectedNodeId = selection.selectedNodeId.value
    if (selectedNodeId) nodeIds.add(selectedNodeId)
    for (const node of getSelectedNodes.value) nodeIds.add(node.id)

    const edgeIds = new Set<string>(getSelectedEdges.value.map((edge) => edge.id))

    // 别人占着的一律不动（含派生占用：接在别人节点上的边也断不得）
    for (const id of [...nodeIds]) {
      if (isLocked("node", id)) nodeIds.delete(id)
    }
    for (const id of [...edgeIds]) {
      if (isLocked("edge", id)) edgeIds.delete(id)
    }
    if (nodeIds.size === 0 && edgeIds.size === 0) return

    // 挂在待删节点上的边要一起删，否则会剩下指向空处的悬空边
    for (const edge of store.edges) {
      if (nodeIds.has(edge.source) || nodeIds.has(edge.target)) edgeIds.add(edge.id)
    }

    // 边在前、节点在后：invertOps 会把顺序倒过来，撤销时先加回节点再加回边
    const ops: FlowOp[] = []
    for (const edge of store.edges) {
      if (edgeIds.has(edge.id)) {
        ops.push({ type: "edge.remove", targetId: edge.id, before: { ...edge }, after: null })
      }
    }
    for (const node of store.nodes) {
      if (nodeIds.has(node.id)) {
        ops.push({ type: "node.remove", targetId: node.id, before: { ...node }, after: null })
      }
    }
    if (ops.length === 0) return

    const label =
      nodeIds.size > 0 ? (edgeIds.size > 0 ? "删除节点和连线" : "删除节点") : "删除连线"
    store.apply(ops, nodeIds.size + edgeIds.size > 1 ? `${label}（${ops.length} 项）` : label)
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
    store.apply([{ type: "node.add", targetId: id, before: null, after: node }], "新增节点")

    // position 是左上角，要等渲染量出尺寸后才能真正居中
    const rendered = findNode(id)
    if (!rendered) return id
    await until(() => rendered.dimensions.width).toBeTruthy({ timeout: 1000 })

    store.apply(
      [
        {
          type: "node.move",
          targetId: id,
          before: { position: center },
          after: {
            position: {
              x: center.x - rendered.dimensions.width / 2,
              y: center.y - rendered.dimensions.height / 2
            }
          }
        }
      ],
      "居中新节点"
    )

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
    deleteSelection,
    lockedKeys,
    isLocked
  }
}

export type FlowCanvas = ReturnType<typeof useFlowCanvas>
