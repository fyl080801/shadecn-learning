import { computed } from "vue"
import { until } from "@vueuse/core"
import {
  useVueFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange
} from "@vue-flow/core"
import { createId } from "@/lib/id"
import type { useFlowStore } from "@/stores/flow"
import { defaultNodeData, type FlowEdge, type FlowNode, type FlowOp } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

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
    onNodeDragStop
  } = useVueFlow()

  /** 交给 Vue Flow 渲染的数据；store 里存的就是它认识的形状 */
  const nodes = computed<Node[]>(() => store.nodes as unknown as Node[])
  const edges = computed<Edge[]>(() => store.edges as unknown as Edge[])

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
      animated: true,
      data: { config: {} }
    }
    store.apply([{ type: "edge.add", targetId: id, before: null, after: edge }], "连线")
  })

  // —— 视口 ——

  /** 视口不进历史、不产生操作，只在保存快照时随行 */
  function syncViewport() {
    store.setViewport(getViewport())
  }

  onPaneReady(() => {
    const { x, y, zoom } = store.viewport
    // 存过视口就恢复它；全新画布才 fitView（且不放大超过 1 倍，
    // 否则 Vue Flow 默认会放到 4 倍，节点大得离谱）
    if (store.nodes.length > 0 && (x !== 0 || y !== 0 || zoom !== 1)) {
      setViewport(store.viewport)
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

  return { nodes, edges, onNodesChange, onWheelZoom, syncViewport, addNode }
}

export type FlowCanvas = ReturnType<typeof useFlowCanvas>
