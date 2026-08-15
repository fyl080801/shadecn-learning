import { computed, ref, watchEffect } from "vue"
import { until, useEventListener } from "@vueuse/core"
import {
  useVueFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange
} from "@vue-flow/core"
import { createId } from "@/lib/id"
import { isEditableTarget } from "./editable"
import type { useFlowStore } from "@/stores/flow"
import { defaultNodeData, type FlowEdge, type FlowNode, type FlowOp } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/** 画布空白处的指针行为 */
export type FlowInteractionMode = "select" | "pan"

/** 连续新增时的层叠偏移，避免节点完全重叠（第一个仍然正好在中心） */
const CASCADE_STEP = 24
const CASCADE_COUNT = 6

/**
 * Vue Flow 与 store 之间的那层胶水：把画布上的交互翻译成 FlowOp。
 *
 * `useVueFlow()` 在这里调用（即编辑器根组件的 setup），后面渲染的 `<VueFlow>`
 * 会接管同一个实例 —— 所以工具栏、胶囊这些不在画布内部的组件也能拿到
 * `screenToFlowCoordinate` 之类的能力。
 */
export function useFlowCanvas(store: FlowStore) {
  const {
    vueFlowRef,
    screenToFlowCoordinate,
    getViewport,
    setViewport,
    findNode,
    minZoom,
    maxZoom,
    fitView,
    onPaneReady,
    onConnect,
    onNodeDragStart,
    onNodeDragStop,
    selectionKeyCode
  } = useVueFlow()

  /** 交给 Vue Flow 渲染的数据；store 里存的就是它认识的形状 */
  const nodes = computed<Node[]>(() => store.nodes as unknown as Node[])
  const edges = computed<Edge[]>(() => store.edges as unknown as Edge[])

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

  onNodeDragStart(({ nodes: dragged }) => {
    for (const node of dragged) dragOrigin.set(node.id, { ...node.position })
  })

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
    if (ops.length === 0) return

    // 框选一起拖 = 一条撤销
    store.apply(ops, ops.length > 1 ? `移动 ${ops.length} 个节点` : "移动节点")
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

  onConnect((connection: Connection) => {
    const id = createId("e")
    const edge: FlowEdge = {
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? null,
      targetHandle: connection.targetHandle ?? null,
      type: "smoothstep",
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
    syncViewport,
    addNode
  }
}

export type FlowCanvas = ReturnType<typeof useFlowCanvas>
