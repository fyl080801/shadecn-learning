import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, defineComponent, h, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { useVueFlow } from "@vue-flow/core"
import { useFlowStore } from "@/stores/flow"
import { useFlowCanvas } from "@/composables/flow/useFlowCanvas"
import type { FlowPresence } from "@/composables/flow/useFlowPresence"
import type { FlowSelection } from "@/composables/flow/useFlowSelection"
import type { FlowDetail } from "@shadecn/shared/canvas"
import { GRAPH_SCHEMA_VERSION } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"

/**
 * `canvas.selectedNodeIds` 按**选中的先后**排（agent 新会话的输入框按这个顺序放提及，docs/20 §3.10.9），
 * 不是 Vue Flow 那份按画布顺序的选中态；只含节点，只选中连线时为空。
 */

vi.mock("vue-sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function detail(): FlowDetail {
  return {
    id: "flow-1",
    projectId: "project-1",
    mode: "collab",
    name: "测试画布",
    description: null,
    status: "draft",
    tags: [],
    thumbnail: null,
    nodeCount: 0,
    edgeCount: 0,
    revision: 0,
    createdById: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: { schemaVersion: GRAPH_SCHEMA_VERSION, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], meta: {} },
    userState: {}
  }
}

function stubPresence(): FlowPresence {
  return {
    nodePositions: computed(() => new Map()),
    setCursor: vi.fn(),
    setSelection: vi.fn(),
    setTransform: vi.fn(),
    clearTransform: vi.fn(),
    setConnecting: vi.fn()
  } as unknown as FlowPresence
}

function stubSelection(): FlowSelection {
  return { selectedNodeId: ref<string | null>(null), select: vi.fn(), clearSelection: vi.fn() } as unknown as FlowSelection
}

let wrapper: VueWrapper | null = null

function setup() {
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  for (const [index, id] of ["a", "b", "c"].entries()) {
    store.addNode(buildNodeRecord({ id, type: "text", label: id, position: { x: index * 300, y: 0 } }))
  }
  store.addEdge({ id: "e1", source: "a", target: "b", sourceHandle: null, targetHandle: null, data: {} })

  let canvas!: ReturnType<typeof useFlowCanvas>
  let flow!: ReturnType<typeof useVueFlow>
  wrapper = mount(
    defineComponent({
      setup() {
        canvas = useFlowCanvas(store, stubPresence(), stubSelection())
        flow = useVueFlow()
        return () => h("div")
      }
    })
  )
  // 没有真的 `<VueFlow>` 在渲染：把映射好的节点 / 连线手动交给 Vue Flow 的状态
  flow.setNodes(canvas.nodes.value)
  flow.setEdges(canvas.edges.value)
  const select = (...ids: string[]) => flow.addSelectedNodes(ids.map((id) => flow.findNode(id)!))
  const unselect = (...ids: string[]) => flow.removeSelectedNodes(ids.map((id) => flow.findNode(id)!))
  return { canvas, flow, select, unselect }
}

describe("选中节点的先后", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("依次加选 c、a、b → [c, a, b]；取消中间的 a 不打乱其余；再选 a 接到最后", () => {
    const { canvas, flow, select, unselect } = setup()
    flow.multiSelectionActive.value = true
    select("c")
    select("a")
    select("b")
    expect(canvas.selectedNodeIds.value).toEqual(["c", "a", "b"])
    unselect("a")
    expect(canvas.selectedNodeIds.value).toEqual(["c", "b"])
    select("a")
    expect(canvas.selectedNodeIds.value).toEqual(["c", "b", "a"])
  })

  it("只选中连线 → 没有选中的节点", () => {
    const { canvas, flow } = setup()
    flow.addSelectedEdges([flow.findEdge("e1")!])
    expect(flow.getSelectedEdges.value.map((edge) => edge.id)).toEqual(["e1"])
    expect(canvas.selectedNodeIds.value).toEqual([])
  })
})
