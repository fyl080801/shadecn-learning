import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, defineComponent, h, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { useVueFlow, type Connection, type Node } from "@vue-flow/core"
import { useFlowStore } from "@/stores/flow"
import { useFlowCanvas } from "@/composables/flow/useFlowCanvas"
import type { FlowPresence } from "@/composables/flow/useFlowPresence"
import type { FlowSelection } from "@/composables/flow/useFlowSelection"
import type { FlowNodeViewData } from "@/components/flow/node-view"
import type { FlowDetail } from "@shadecn/shared/canvas"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"

/**
 * `useFlowCanvas` 里和 v3 有关的那几件事：
 * 投影节点 → Vue Flow 节点的映射（对象身份、layout 摊平、四组进 data）、
 * 拉线校验（和 agent 共用 shared 的 `validateConnection`）、从带类型的端口长出新节点。
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
    graph: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {}
    },
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
  return {
    selectedNodeId: ref<string | null>(null),
    select: vi.fn(),
    clearSelection: vi.fn()
  } as unknown as FlowSelection
}

function record(id: string, type: string, x = 0): FlowNodeRecord {
  return buildNodeRecord({ id, type, label: id, position: { x, y: 0 } })
}

let wrapper: VueWrapper | null = null

function setup() {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)

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
  /** 没有真的 `<VueFlow>` 在渲染：把映射好的节点手动交给 Vue Flow 的状态，`findNode` 才找得到 */
  const syncToVueFlow = () => flow.setNodes(canvas.nodes.value)
  return { store, doc, canvas, flow, syncToVueFlow }
}

function connection(partial: Partial<Connection>): Connection {
  return { source: "", target: "", sourceHandle: null, targetHandle: null, ...partial } as Connection
}

describe("投影节点 → Vue Flow 节点", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("layout 摊到顶层（布局键显式写出），其余四组进 data", () => {
    const { store, canvas } = setup()
    store.addNode({ ...record("n1", "text"), data: { text: "正文" } })

    const view = canvas.nodes.value[0] as Node<FlowNodeViewData>
    expect(view).toMatchObject({ id: "n1", type: "text", position: { x: 0, y: 0 } })
    // 没有的布局键也要以 undefined 出现：Vue Flow 合并节点用 Object.assign，缺键会留着旧值
    expect("extent" in view && "parentNode" in view && "width" in view).toBe(true)
    expect(view.data).toEqual({
      metadata: store.nodes[0]!.metadata,
      data: { text: "正文" },
      runtime: { status: "idle" },
      inputs: []
    })
  })

  it("改一个节点：别的节点交给 Vue Flow 的还是同一个对象", () => {
    const { store, canvas } = setup()
    store.addNode(record("a", "text"))
    store.addNode(record("b", "text"))
    const before = new Map(canvas.nodes.value.map((node) => [node.id, node]))

    store.writeNode("a", "metadata", { set: { label: "改名" } })

    const after = new Map(canvas.nodes.value.map((node) => [node.id, node]))
    expect(after.get("a")).not.toBe(before.get("a"))
    expect(after.get("b")).toBe(before.get("b"))
  })
})

describe("拉线校验与端口", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("isValidConnection 忽略 handle id，按自动选端口判：有一对能连就行，一对都没有才拒绝", () => {
    const { store, canvas } = setup()
    store.addNode(record("src", "image-source"))
    store.addNode(record("txt", "text-input"))
    store.addNode(record("txt2", "text-input"))
    store.addNode(record("cfg", "image-config"))
    store.addNode(record("t1", "text"))
    store.addNode(record("t2", "text"))

    const ok = (partial: Partial<Connection>) => canvas.isValidConnection(connection(partial))
    expect(ok({ source: "src", target: "cfg" })).toBe(true)
    expect(ok({ source: "txt", target: "src" })).toBe(false)
    expect(ok({ source: "t1", target: "t2" })).toBe(true)
    // 只有输出的类型（text-input）连不进去
    expect(ok({ source: "t1", target: "txt" })).toBe(false)

    store.addEdge({
      id: "e1",
      source: "txt",
      target: "cfg",
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: "text", targetPort: "text", index: 1 }
    })
    // 提示词端口是单输入：第二个文本输入没有别的端口可去
    expect(ok({ source: "txt2", target: "cfg" })).toBe(false)
  })

  it("拉线连上（onConnect）：handle 为空，自动选出的端口和序号写进 data", () => {
    const { store, flow } = setup()
    store.addNode(record("dc", "director-console"))
    store.addNode(record("vsrc", "video-source"))
    store.addNode(record("t1", "text"))
    store.addNode(record("t2", "text"))

    flow.emits.connect(connection({ source: "dc", target: "vsrc" }))
    flow.emits.connect(connection({ source: "t1", target: "t2" }))

    expect(store.edges.map((edge) => [edge.source, edge.sourceHandle, edge.targetHandle, edge.data])).toEqual([
      ["dc", null, null, expect.objectContaining({ sourcePort: "video", targetPort: "video", index: 1 })],
      ["t1", null, null, { createdAt: expect.any(Number) }]
    ])
  })

  it("交给 Vue Flow 的边 handle 一律为空（连接点不带 id，带 id 的老边也照样渲染）", () => {
    const { store, canvas } = setup()
    store.addNode(record("a", "image-source"))
    store.addNode(record("b", "image-config"))
    store.addEdge({ id: "e", source: "a", target: "b", sourceHandle: "image", targetHandle: "image", data: {} })
    expect(canvas.edges.value[0]).toMatchObject({ sourceHandle: null, targetHandle: null })
  })

  it("从带端口的节点往右长：取注册表里第一个能连上的类型，端口写进边的 data", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { store, canvas, syncToVueFlow } = setup()
      store.addNode(record("src", "image-source"))
      syncToVueFlow()

      const pending = canvas.addConnectedNode("src", "source")
      await vi.advanceTimersByTimeAsync(1100)
      const id = (await pending)!

      expect(store.nodeById.get(id)!.type).toBe("image-config")
      expect(store.edges).toHaveLength(1)
      expect(store.edges[0]).toMatchObject({
        source: "src",
        target: id,
        sourceHandle: null,
        targetHandle: null,
        data: { sourcePort: "image", targetPort: "image", index: 1 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("从无端口的节点长出来的照旧是默认的文本节点，线的 data 里没有端口", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { store, canvas, syncToVueFlow } = setup()
      store.addNode(record("t1", "text"))
      syncToVueFlow()

      const pending = canvas.addConnectedNode("t1", "source")
      await vi.advanceTimersByTimeAsync(1100)
      const id = (await pending)!

      expect(store.nodeById.get(id)!.type).toBe("text")
      expect(store.edges[0]).toMatchObject({ sourceHandle: null, targetHandle: null })
      expect(store.edges[0]!.data).not.toHaveProperty("targetPort")
    } finally {
      vi.useRealTimers()
    }
  })

  it("往多输入端口回长两次：序号依次是 1、2", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { store, canvas, syncToVueFlow } = setup()
      // 导演台只有一个多输入的图片端口
      store.addNode(record("dc", "director-console"))
      syncToVueFlow()

      for (let round = 0; round < 2; round += 1) {
        const pending = canvas.addConnectedNode("dc", "target", { x: -400, y: round * 300 })
        await vi.advanceTimersByTimeAsync(1100)
        await pending
        syncToVueFlow()
      }

      expect(store.edges.map((edge) => [edge.data.targetPort, edge.data.index])).toEqual([
        ["image", 1],
        ["image", 2]
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("往已经接满的单输入节点回长：提示原因，不建节点也不连线", async () => {
    const { store, canvas, syncToVueFlow } = setup()
    store.addNode(record("a", "image-source"))
    store.addNode(record("b", "image-source"))
    store.addEdge({
      id: "e1",
      source: "a",
      target: "b",
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: "image", targetPort: "image", index: 1 }
    })
    syncToVueFlow()

    expect(await canvas.addConnectedNode("b", "target")).toBeNull()
    expect(store.nodes).toHaveLength(2)
    expect(store.edges).toHaveLength(1)
  })
})
