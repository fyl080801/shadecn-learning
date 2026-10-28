import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { nodeGroup } from "@shadecn/shared/flow-doc"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"
import { useFlowStore } from "@/stores/flow"
import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import { nodeKitGlobal } from "./node-kit/with-kit"

/**
 * 画布上的节点（宿主 `NodeHost` + 默认注册表里的类型与能力）：运行态的展示、按端口声明画连接点（分组不画）、
 * 改名经 `useFlowNode` 写到 `metadata.label`、分组的解组、文本的就地编辑。
 *
 * 数据走真的 store + Y.Doc（`useFlowNode` 直接读 store）；Vue Flow 那几个要画布上下文的组件
 * （Handle / NodeToolbar / NodeResizer）换成只渲染自己的替身 —— 这里测的是基础组件交给它们什么，
 * 不是 Vue Flow 本身。
 */

const selectOnly = vi.fn()
const addConnectedNode = vi.fn()
const deleteNode = vi.fn()
const selectedNodeId = ref<string | null>(null)

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly,
      addConnectedNode,
      deleteNode,
      duplicateNode: vi.fn(),
      isValidConnection: () => true,
      boxSelecting: ref(false)
    },
    presence: { occupantsOf: () => [] },
    selection: { selectedNodeId },
    store: useFlowStore()
  })
}))

vi.mock("@vue-flow/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vue-flow/core")>()),
  Handle: defineComponent({
    props: { id: { type: String, default: null }, type: String, position: String },
    setup(props) {
      return () =>
        h("div", {
          "data-stub": "handle",
          "data-handle-id": props.id ?? "",
          "data-handle-type": props.type
        })
    }
  }),
  useNodeConnections: () => ref([])
}))

vi.mock("@vue-flow/node-toolbar", () => ({
  NodeToolbar: defineComponent({
    props: { isVisible: Boolean },
    setup(props, { slots }) {
      return () => (props.isVisible ? h("div", { "data-stub": "toolbar" }, slots.default?.()) : null)
    }
  })
}))

vi.mock("@vue-flow/node-resizer", () => ({
  NodeResizer: defineComponent({ setup: () => () => h("div", { "data-stub": "resizer" }) })
}))

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

function record(id: string, type: string, patch: Partial<FlowNodeRecord> = {}): FlowNodeRecord {
  return { ...buildNodeRecord({ id, type, label: `节点 ${id}`, position: { x: 0, y: 0 } }), ...patch }
}

let wrapper: VueWrapper | null = null

function setup(...nodes: FlowNodeRecord[]) {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)
  for (const node of nodes) store.addNode(node)
  return { store, doc }
}

/** Vue Flow 交给节点组件的那几个 props（只给组件真正读的） */
function nodeProps(id: string, type: string) {
  return { id, type, selected: false, data: {} } as never
}

describe("画布节点", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    selectOnly.mockClear()
    addConnectedNode.mockClear()
    selectedNodeId.value = null
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("runtime.status 为 processing：根元素标上状态并出现「运行中」角标，没有错误信息", () => {
    setup(record("n1", "process", { runtime: { status: "processing" } }))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "process") })

    expect(wrapper.attributes("data-status")).toBe("processing")
    expect(wrapper.find('[data-testid="node-status-processing"]').text()).toContain("运行中")
    expect(wrapper.find('[data-testid="node-status-error"]').exists()).toBe(false)
  })

  it("runtime.status 为 error：显示 runtime.error；没有错误文案时给兜底", async () => {
    const { store } = setup(record("n1", "process", { runtime: { status: "error", error: "模型超时" } }))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "process") })

    expect(wrapper.attributes("data-status")).toBe("error")
    expect(wrapper.find('[data-testid="node-status-error"]').text()).toBe("模型超时")
    expect(wrapper.classes()).toContain("border-destructive")

    store.writeNode("n1", "runtime", { remove: ["error"] })
    await nextTick()
    expect(wrapper.find('[data-testid="node-status-error"]').text()).toBe("运行出错")
  })

  it("idle：既没有角标也没有错误信息；body 是类型外观里声明的那个", () => {
    setup(record("n1", "text"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "text") })

    expect(wrapper.attributes("data-status")).toBe("idle")
    expect(wrapper.find('[data-testid="node-status-processing"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="node-status-error"]').exists()).toBe(false)
    expect(wrapper.find('p[title="双击编辑文本"]').text()).toBe("双击输入文本")
  })

  it("没声明端口的类型：左右各一个不带 id 的连接点", () => {
    setup(record("n1", "process"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "process") })

    const handles = wrapper.findAll('[data-stub="handle"]')
    expect(handles.map((item) => [item.attributes("data-handle-type"), item.attributes("data-handle-id")])).toEqual([
      ["target", ""],
      ["source", ""]
    ])
  })

  it("声明了多个端口的类型：照样只有左右各一个不带 id 的连接点（端口不画成多个 Handle）", () => {
    setup(record("cfg", "director-console"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("cfg", "director-console") })

    const handles = wrapper.findAll('[data-stub="handle"]')
    expect(handles.map((item) => [item.attributes("data-handle-type"), item.attributes("data-handle-id")])).toEqual([
      ["target", ""],
      ["source", ""]
    ])
  })

  it("只声明了输出的类型（text-input）左边没有连接点，右边一个不带 id", () => {
    setup(record("txt", "text-input"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("txt", "text-input") })

    const handles = wrapper.findAll('[data-stub="handle"]')
    expect(handles.map((item) => [item.attributes("data-handle-type"), item.attributes("data-handle-id")])).toEqual([
      ["source", ""]
    ])
  })

  it("分组不画连接点（类型声明不启用 connectable），但外壳和拉伸手柄照常", () => {
    setup(record("g1", "group"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("g1", "group") })

    expect(wrapper.findAll('[data-stub="handle"]')).toHaveLength(0)
    expect(wrapper.find('[data-stub="resizer"]').exists()).toBe(true)
    // 名字照样由外壳画在框外
    expect(wrapper.text()).toContain("节点 g1")
  })

  it("双击名字改名：经 useFlowNode 写到 metadata.label，data 不受影响", async () => {
    const { store, doc } = setup(record("n1", "image-config", { data: { prompt: "一只猫" } }))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "image-config") })

    await wrapper.find('span[title="双击改名"]').trigger("dblclick")
    expect(selectOnly).toHaveBeenCalledWith("n1")
    const input = wrapper.find("input")
    await input.setValue("  新名字  ")
    await input.trigger("keydown", { key: "Enter" })

    const node = store.nodeById.get("n1")!
    expect(node.metadata.label).toBe("新名字")
    expect(node.data).toEqual({ prompt: "一只猫" })
    expect(nodeGroup(doc, "n1", "metadata")!.get("label")).toBe("新名字")
    expect(nodeGroup(doc, "n1", "data")!.has("label")).toBe(false)
  })

  it("改名改成空白不提交（误操作不是改名）", async () => {
    const { store } = setup(record("n1", "process"))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "process") })

    await wrapper.find('span[title="双击改名"]').trigger("dblclick")
    const input = wrapper.find("input")
    await input.setValue("   ")
    await input.trigger("blur")

    expect(store.nodeById.get("n1")!.metadata.label).toBe("节点 n1")
  })

  it("没起名的老节点显示兜底名（类型外观的 fallbackLabel）", () => {
    setup(record("n1", "process", { metadata: { label: "" } }))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("n1", "process") })
    expect(wrapper.find('span[title="双击改名"]').text()).toBe("流程节点")
  })

  it("分组：工具条上只有「解组」，点了走画布的 deleteNode（组内节点由 store 解开）", async () => {
    setup(record("g1", "group"))
    selectedNodeId.value = "g1"
    deleteNode.mockClear()
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("g1", "group") })
    await nextTick()

    const buttons = wrapper.findAll('[data-node-slot="toolbar"] button')
    expect(buttons.map((item) => item.attributes("title"))).toEqual(["解组（拆掉分组框，组内节点保留）（Mod+Shift+G）"])
    await buttons[0]?.trigger("click")
    expect(deleteNode).toHaveBeenCalledWith("g1")
  })

  it("文本：双击节点本体进入编辑，失焦提交到 data.text；双击不再冒泡到画布", async () => {
    const { store } = setup(record("t1", "text"))
    const outer = vi.fn()
    wrapper = mount(
      defineComponent({
        setup: () => () => h("div", { onDblclick: outer }, [h(NodeHost, nodeProps("t1", "text"))])
      }),
      { global: nodeKitGlobal() }
    )

    await wrapper.find('p[title="双击编辑文本"]').trigger("dblclick")
    expect(selectOnly).toHaveBeenCalledWith("t1")
    expect(outer).not.toHaveBeenCalled()
    const textarea = wrapper.find("textarea")
    await textarea.setValue("第一行\n第二行")
    await textarea.trigger("blur")

    expect(store.nodeById.get("t1")!.data.text).toBe("第一行\n第二行")
    expect(wrapper.find("textarea").exists()).toBe(false)
  })

  it("文本：Esc 取消编辑，不写文档", async () => {
    const { store } = setup(record("t1", "text", { data: { text: "原文" } }))
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("t1", "text") })

    await wrapper.find('p[title="双击编辑文本"]').trigger("dblclick")
    await wrapper.find("textarea").setValue("改了")
    await wrapper.find("textarea").trigger("keydown", { key: "Escape" })

    expect(store.nodeById.get("t1")!.data.text).toBe("原文")
    expect(wrapper.find("textarea").exists()).toBe(false)
  })
})

describe("GenericBody 的通用 body", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("展示名字、关键业务字段、连进来的输入和输出端口的产出", () => {
    const { store } = setup(
      record("src", "image-source", {
        metadata: { label: "参考图" },
        runtime: { status: "completed", outputs: { image: "https://x/a.png" } }
      }),
      record("cfg", "image-config", {
        metadata: { label: "生图" },
        data: { prompt: "一只猫", width: 1024, scene: { big: true } },
        runtime: { status: "completed", outputs: { image: "https://x/out.png" } }
      })
    )
    store.addEdge({
      id: "e1",
      source: "src",
      target: "cfg",
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: "image", targetPort: "image", index: 1 }
    })
    wrapper = mount(NodeHost, { global: nodeKitGlobal(), props: nodeProps("cfg", "image-config") })

    expect(wrapper.find('[data-testid="generic-node-label"]').text()).toBe("生图")
    const summary = wrapper.find('[data-testid="generic-node-summary"]').text()
    expect(summary).toContain("prompt")
    expect(summary).toContain("一只猫")
    // 大对象不展开
    expect(summary).not.toContain("scene")
    expect(wrapper.find('[data-testid="generic-node-inputs"]').text()).toContain("参考图 #1")
    expect(wrapper.find('[data-testid="generic-node-outputs"] img').attributes("src")).toBe(
      "https://x/out.png"
    )
  })
})
