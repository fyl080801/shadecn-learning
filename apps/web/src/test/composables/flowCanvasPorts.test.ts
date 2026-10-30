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
 * 拉线校验（和 agent 共用 shared 的 `resolveConnection`，带节点数据）、从出口长出新节点的候选菜单。
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

  it("isValidConnection 忽略 handle id，按 shared 的规则（交互门 + 逻辑门，带节点数据）判", () => {
    const { store, canvas } = setup()
    store.addNode(record("t1", "text"))
    store.addNode(record("img", "image"))
    store.addNode({ ...record("full", "image"), data: { src: "https://x/a.png" } })
    store.addNode({ ...record("asset", "image"), data: { src: "https://x/a.png", form: "asset" } })
    store.addNode(record("vid", "video"))
    store.addNode(record("dc", "director"))
    store.addNode(record("p1", "process"))
    store.addNode(record("p2", "process"))

    const ok = (partial: Partial<Connection>) => canvas.isValidConnection(connection(partial))
    expect(ok({ source: "t1", target: "img" })).toBe(true)
    expect(ok({ source: "t1", target: "dc" })).toBe(true)
    expect(ok({ source: "dc", target: "img" })).toBe(true)
    expect(ok({ source: "img", target: "dc" })).toBe(true)
    // 文本没有输入
    expect(ok({ source: "img", target: "t1" })).toBe(false)
    // generate 形态的图片有了图照样能连；asset（素材）形态的不接受拖进来的线
    expect(ok({ source: "t1", target: "full" })).toBe(true)
    expect(ok({ source: "t1", target: "asset" })).toBe(false)
    expect(ok({ source: "asset", target: "img" })).toBe(true)
    // 导演台不收视频
    expect(ok({ source: "vid", target: "dc" })).toBe(false)
    // 认不出 / 兜底的老节点和谁都能连
    expect(ok({ source: "p1", target: "p2" })).toBe(true)
    // 带 handle id 的也一样判（连接点不带 id，给了也忽略）
    expect(ok({ source: "t1", target: "img", sourceHandle: "x", targetHandle: "y" })).toBe(true)
  })

  it("拉线连上（onConnect）：handle 为空，自动选出的端口和序号写进 data；被连过还能再连别的", () => {
    const { store, flow } = setup()
    store.addNode(record("dc", "director"))
    store.addNode(record("img", "image"))
    store.addNode(record("t1", "text"))
    store.addNode(record("t2", "text"))

    flow.emits.connect(connection({ source: "dc", target: "img" }))
    flow.emits.connect(connection({ source: "dc", target: "img" }))
    flow.emits.connect(connection({ source: "t1", target: "img" }))
    flow.emits.connect(connection({ source: "t2", target: "img" }))

    expect(store.edges.map((edge) => [edge.source, edge.sourceHandle, edge.targetHandle, edge.data])).toEqual([
      ["dc", null, null, expect.objectContaining({ sourcePort: "image", targetPort: "image", index: 1 })],
      ["dc", null, null, expect.objectContaining({ sourcePort: "video", targetPort: "video", index: 1 })],
      ["t1", null, null, expect.objectContaining({ sourcePort: "text", targetPort: "text", index: 1 })],
      ["t2", null, null, expect.objectContaining({ sourcePort: "text", targetPort: "text", index: 2 })]
    ])
  })

  it("松手时目标是素材（asset）：不建边，提示原因，形态不变；generate 有了图照样能连", async () => {
    const { toast } = await import("vue-sonner")
    const { store, flow } = setup()
    store.addNode(record("t1", "text"))
    store.addNode(record("t2", "text"))
    store.addNode(record("img", "image"))
    store.addNode(record("pic", "image"))
    // 有连入时上传：仍是 generate，还能再连
    flow.emits.connect(connection({ source: "t1", target: "img" }))
    store.attachAsset("img", { src: "https://x/a.png" })
    flow.emits.connect(connection({ source: "t2", target: "img" }))
    expect(store.edges).toHaveLength(2)

    // 没有连入时上传：成了素材，拖线连不进去
    store.attachAsset("pic", { src: "https://x/b.png" })
    expect(store.nodeById.get("pic")!.data.form).toBe("asset")
    flow.emits.connect(connection({ source: "t1", target: "pic" }))
    expect(store.edges).toHaveLength(2)
    expect(store.nodeById.get("pic")!.data.form).toBe("asset")
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("素材"))
  })

  it("交给 Vue Flow 的边 handle 一律为空（连接点不带 id，带 id 的老边也照样渲染）", () => {
    const { store, canvas } = setup()
    store.addNode(record("a", "image"))
    store.addNode(record("b", "image"))
    store.addEdge({ id: "e", source: "a", target: "b", sourceHandle: "image", targetHandle: "image", data: {} })
    expect(canvas.edges.value[0]).toMatchObject({ sourceHandle: null, targetHandle: null })
  })
})

describe("从出口长出新节点：候选菜单", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, "elementFromPoint")
  })

  const typesOf = (canvas: ReturnType<typeof useFlowCanvas>) => canvas.growCandidates.value.map((item) => item.type)

  /** jsdom 没有 `document.elementFromPoint`：装一个返回指定元素的替身（`droppedOnPane` 靠它判落点） */
  function stubElementFromPoint(element: Element) {
    const fn = vi.fn((_x: number, _y: number): Element | null => element)
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: fn })
    return fn
  }

  it("点出口加号：弹出菜单（锚在连接点上），只列能连上的类型；没选就什么都不建", () => {
    const { store, canvas, syncToVueFlow } = setup()
    store.addNode(record("t1", "text"))
    store.addNode(record("vid", "video"))
    syncToVueFlow()
    const handle = document.createElement("div")

    canvas.openGrowMenu("t1", { anchor: handle })
    expect(canvas.growMenu.value).toMatchObject({ sourceId: "t1", reference: handle })
    expect(typesOf(canvas)).toEqual(["image", "video", "director"])

    canvas.openGrowMenu("vid", { anchor: handle })
    expect(typesOf(canvas)).toEqual(["image", "video"])

    canvas.closeGrowMenu()
    expect(canvas.growMenu.value).toBeNull()
    expect(typesOf(canvas)).toEqual([])
    expect(store.nodes).toHaveLength(2)
  })

  it("从出口拉线到空白处松手：不直接建节点，在落点弹出同一个菜单", () => {
    const { store, canvas, flow, syncToVueFlow } = setup()
    store.addNode(record("dc", "director"))
    syncToVueFlow()
    // 没有真的 <VueFlow>：给它一个画布根元素，并让「落点下面的元素」落在画布空白上
    const pane = document.createElement("div")
    document.body.append(pane)
    flow.vueFlowRef.value = pane
    stubElementFromPoint(pane)

    flow.emits.connectStart({ nodeId: "dc", handleId: null, handleType: "source" } as never)
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 300, clientY: 200 }))

    expect(store.nodes).toHaveLength(1)
    expect(canvas.growMenu.value?.sourceId).toBe("dc")
    expect(canvas.growMenu.value?.reference.getBoundingClientRect()).toMatchObject({ x: 300, y: 200, width: 0, height: 0 })
    expect(typesOf(canvas)).toEqual(["image", "video", "director"])
    pane.remove()
  })

  it("落在节点身上（没对准入口）：直接连到它，不弹菜单；连不上就不建边", () => {
    const { store, canvas, flow, syncToVueFlow } = setup()
    store.addNode(record("t1", "text"))
    store.addNode(record("img", "image"))
    store.addNode(record("t2", "text"))
    syncToVueFlow()
    const pane = document.createElement("div")
    const nodeEl = document.createElement("div")
    nodeEl.className = "vue-flow__node"
    nodeEl.setAttribute("data-id", "img")
    const inner = document.createElement("span")
    nodeEl.append(inner)
    pane.append(nodeEl)
    document.body.append(pane)
    flow.vueFlowRef.value = pane
    stubElementFromPoint(inner)

    flow.emits.connectStart({ nodeId: "t1", handleId: null, handleType: "source" } as never)
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 1, clientY: 1 }))
    expect(canvas.growMenu.value).toBeNull()
    expect(store.edges).toHaveLength(1)
    expect(store.edges[0]).toMatchObject({ source: "t1", target: "img", data: { sourcePort: "text", targetPort: "text" } })

    // 文本没有入口：落在它身上连不上，不建边也不弹菜单
    nodeEl.setAttribute("data-id", "t2")
    flow.emits.connectStart({ nodeId: "t1", handleId: null, handleType: "source" } as never)
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 1, clientY: 1 }))
    expect(canvas.growMenu.value).toBeNull()
    expect(store.edges).toHaveLength(1)

    // 落回起点自己身上：什么都不做
    nodeEl.setAttribute("data-id", "t1")
    flow.emits.connectStart({ nodeId: "t1", handleId: null, handleType: "source" } as never)
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 1, clientY: 1 }))
    expect(store.edges).toHaveLength(1)
    pane.remove()
  })

  it("真的连上了（落在入口上）：不弹菜单，也不会再连一次", () => {
    const { store, canvas, flow, syncToVueFlow } = setup()
    store.addNode(record("t1", "text"))
    store.addNode(record("img", "image"))
    syncToVueFlow()
    const pane = document.createElement("div")
    document.body.append(pane)
    flow.vueFlowRef.value = pane
    stubElementFromPoint(pane)

    flow.emits.connectStart({ nodeId: "t1", handleId: null, handleType: "source" } as never)
    flow.emits.connect(connection({ source: "t1", target: "img" }))
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 1, clientY: 1 }))
    expect(canvas.growMenu.value).toBeNull()
    expect(store.edges).toHaveLength(1)
    pane.remove()
  })

  it("从入口起的拉线（规则上不该发生）松手也不弹菜单：线只从出口往入口连", () => {
    const { store, canvas, flow, syncToVueFlow } = setup()
    store.addNode(record("img", "image"))
    syncToVueFlow()
    const pane = document.createElement("div")
    document.body.append(pane)
    flow.vueFlowRef.value = pane
    stubElementFromPoint(pane)

    flow.emits.connectStart({ nodeId: "img", handleId: null, handleType: "target" } as never)
    flow.emits.connectEnd(new MouseEvent("mouseup", { clientX: 1, clientY: 1 }))
    expect(canvas.growMenu.value).toBeNull()
    pane.remove()
  })

  it("在菜单里选一种：建节点 + 连线（端口写进 data），落在菜单记下的位置；一次撤销两样都拿掉", async () => {
    const { store, canvas, syncToVueFlow } = setup()
    store.addNode(record("dc", "director"))
    syncToVueFlow()
    canvas.openGrowMenu("dc", { anchor: document.createElement("div") })
    const at = canvas.growMenu.value!.at

    const id = (await canvas.growFromMenu("video"))!
    expect(canvas.growMenu.value).toBeNull()
    const created = store.nodeById.get(id)!
    expect(created.type).toBe("video")
    expect(created.data).toEqual({ src: "", poster: "" })
    expect(created.layout.position).toEqual({ x: at.x, y: at.y })
    expect(store.edges).toHaveLength(1)
    expect(store.edges[0]).toMatchObject({
      source: "dc",
      target: id,
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: "image", targetPort: "image", index: 1 }
    })

    store.undo()
    expect(store.nodeById.has(id)).toBe(false)
    expect(store.edges).toHaveLength(0)
    expect(store.nodes.map((node) => node.id)).toEqual(["dc"])
  })

  it("菜单开着时起点被删了：选了也不建节点，提示原因", async () => {
    const { toast } = await import("vue-sonner")
    const { store, canvas, syncToVueFlow } = setup()
    store.addNode(record("t1", "text"))
    syncToVueFlow()
    canvas.openGrowMenu("t1", { anchor: document.createElement("div") })
    store.removeElements(["t1"], [])

    expect(typesOf(canvas)).toEqual([])
    expect(await canvas.growFromMenu("image")).toBeNull()
    expect(store.nodes).toHaveLength(0)
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("undefined"))
  })
})
