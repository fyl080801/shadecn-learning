import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { GRAPH_SCHEMA_VERSION } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"

import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import { FLOW_NODE_TYPES } from "@/components/flow/node-types"
import { provideNodeKit, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"
import { DOWNLOAD_FRAME_TTL } from "@/components/flow/node-kit/features/download"
import { useFlowStore } from "@/stores/flow"

/**
 * 默认注册表（`install.ts`）里的那几个能力：各类型最终挂了什么，以及改名作为编辑模式的行为 ——
 * 整张画布同时只有一个节点可编辑。
 */

const selectOnly = vi.fn()
const duplicateNode = vi.fn()
const deleteNode = vi.fn()
const selectedNodeId = ref<string | null>(null)

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly,
      addConnectedNode: vi.fn(),
      deleteNode,
      duplicateNode,
      isValidConnection: () => true,
      boxSelecting: ref(false),
      zoomLevel: ref(1)
    },
    presence: { occupantsOf: () => [] },
    selection: { selectedNodeId },
    flowId: ref("flow-1"),
    store: useFlowStore()
  })
}))

vi.mock("@vue-flow/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vue-flow/core")>()),
  Handle: defineComponent({ setup: () => () => h("div", { "data-stub": "handle" }) }),
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

/** Vue Flow 交给节点组件的那几个 props（只给宿主真正读的） */
function nodeProps(id: string, type: string) {
  return { id, type, selected: false, data: {} } as never
}

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id)

describe("默认注册表的组合", () => {
  it("每个注册了的节点类型都登记进去，且引用的能力都存在", () => {
    const kit = createDefaultNodeKit()
    expect(kit.validate()).toEqual([])
    for (const def of Object.values(FLOW_NODE_TYPES)) {
      expect(kit.featuresOf(def.type)).toEqual(def.features)
    }
  })

  it("普通节点：名字、复制 + 删除、连接点、运行态；分组不连线", () => {
    const kit = createDefaultNodeKit()

    expect(ids(kit.partsFor("text", "label"))).toEqual(["rename.title"])
    expect(ids(kit.actionsFor("text", "toolbar"))).toEqual(["node.duplicate", "node.delete"])
    expect(ids(kit.partsFor("text", "handles"))).toEqual(["connectable.handles"])
    expect(ids(kit.partsFor("text", "badge"))).toEqual(["status.badge"])

    expect(ids(kit.partsFor("group", "label"))).toEqual(["rename.title"])
    expect(kit.partsFor("group", "handles")).toHaveLength(0)
  })

  it("只有图片 / 视频启用下载，排在复制和删除之间", () => {
    const kit = createDefaultNodeKit()
    for (const type of Object.keys(FLOW_NODE_TYPES)) {
      expect(kit.hasFeature(type, "download"), type).toBe(type === "image" || type === "video")
    }
    expect(ids(kit.actionsFor("image", "toolbar"))).toEqual(["node.duplicate", "node.download", "node.delete"])
  })

  it("分组：解组、拉伸、顶部把手；文本多一个就地编辑", () => {
    const kit = createDefaultNodeKit()
    expect(ids(kit.actionsFor("group", "toolbar"))).toEqual(["group.ungroup"])
    expect(ids(kit.partsFor("group", "overlay"))).toEqual(["resizable.handles", "drag-strip.handle"])
    expect(kit.findMode("text", "edit-body")).not.toBeNull()
    expect(kit.findMode("process", "edit-body")).toBeNull()
  })

  it("底部输入框按类型注册：文本 / 图片 / 视频 / 导演台各一个，兜底和分组没有；编辑模式来自能力 edit-prompt", () => {
    const kit = createDefaultNodeKit()
    const withComposer = ["text", "image", "video", "director"]
    for (const type of Object.keys(FLOW_NODE_TYPES)) {
      expect(ids(kit.partsFor(type, "composer")), type).toEqual(withComposer.includes(type) ? [`${type}.composer`] : [])
      expect(kit.findMode(type, "edit-prompt") !== null, type).toBe(withComposer.includes(type))
    }
  })

  it("产出预览、可运行是登记着的通用能力，但眼下没有类型启用", () => {
    const kit = createDefaultNodeKit()
    for (const type of Object.keys(FLOW_NODE_TYPES)) {
      expect(kit.partsFor(type, "side"), type).toHaveLength(0)
      expect(kit.hasFeature(type, "runnable"), type).toBe(false)
      expect(kit.hasFeature(type, "output-preview"), type).toBe(false)
    }
  })

  it("每种类型的 body 是自己登记的那个；兜底类型没有 body", () => {
    const kit = createDefaultNodeKit()
    for (const type of ["text", "image", "video", "director"]) {
      expect(kit.viewOf(type).body, type).toBe(FLOW_NODE_TYPES[type]!.view.body)
      expect(kit.viewOf(type).body, type).toBeDefined()
    }
    expect(kit.viewOf("process").body).toBeUndefined()
  })
})

describe("复制 / 删除动作", () => {
  let wrapper: VueWrapper | null = null
  beforeEach(() => {
    setActivePinia(createPinia())
    selectedNodeId.value = "n1"
    duplicateNode.mockClear()
    deleteNode.mockClear()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("单独选中时出现在工具条上，点了调画布对应的方法；删除是红色的", async () => {
    const store = useFlowStore()
    store.load(detail())
    store.attachDoc(new Y.Doc())
    store.addNode(buildNodeRecord({ id: "n1", type: "process", label: "甲", position: { x: 0, y: 0 } }))
    const Root = defineComponent({
      setup() {
        provideNodeKit(createDefaultNodeKit(), selectedNodeId)
        return () => h(NodeHost, nodeProps("n1", "process"))
      }
    })
    wrapper = mount(Root)

    await wrapper.find('[data-node-action="node.duplicate"]').trigger("click")
    await wrapper.find('[data-node-action="node.delete"]').trigger("click")

    expect(duplicateNode).toHaveBeenCalledWith("n1")
    expect(deleteNode).toHaveBeenCalledWith("n1")
    expect(wrapper.find('[data-node-action="node.delete"]').classes()).toContain("text-destructive")
  })
})

describe("下载动作", () => {
  let wrapper: VueWrapper | null = null
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
  const src = `https://s3.example.test/bucket/canvas/assets/3f/a8/${id}.png`

  beforeEach(() => {
    setActivePinia(createPinia())
    selectedNodeId.value = "n1"
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
  })

  function mountImage(src: string) {
    const store = useFlowStore()
    store.load(detail())
    store.attachDoc(new Y.Doc())
    store.addNode(buildNodeRecord({ id: "n1", type: "image", label: "封面图", position: { x: 0, y: 0 } }))
    if (src) store.attachAsset("n1", { src })
    const Root = defineComponent({
      setup() {
        provideNodeKit(createDefaultNodeKit(), selectedNodeId)
        return () => h(NodeHost, nodeProps("n1", "image"))
      }
    })
    wrapper = mount(Root)
    return wrapper
  }

  it("没有资源 → 不出现", () => {
    expect(mountImage("").find('[data-node-action="node.download"]').exists()).toBe(false)
  })

  it("点了按节点名下载：素材地址带 response-content-disposition，在隐藏 iframe 里打开，页面不跳走", async () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    await mountImage(src).find('[data-node-action="node.download"]').trigger("click")
    await nextTick()

    const frame = document.body.querySelector("iframe")
    expect(frame).not.toBeNull()
    expect(frame!.style.display).toBe("none")
    expect(new URL(frame!.src).searchParams.get("response-content-disposition")).toContain(
      "filename*=UTF-8''%E5%B0%81%E9%9D%A2%E5%9B%BE.png"
    )
    // 没有走 <a>：跨源的 <a> 会导航（整页或新标签）
    expect(click).not.toHaveBeenCalled()

    vi.advanceTimersByTime(DOWNLOAD_FRAME_TTL)
    expect(frame!.isConnected).toBe(false)
    vi.useRealTimers()
  })
})

describe("改名是一个编辑模式", () => {
  let wrapper: VueWrapper | null = null
  let runtime: NodeKitRuntime

  beforeEach(() => {
    setActivePinia(createPinia())
    selectedNodeId.value = null
    selectOnly.mockClear()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  function mountTwo() {
    const store = useFlowStore()
    store.load(detail())
    store.attachDoc(new Y.Doc())
    store.addNode(buildNodeRecord({ id: "a", type: "process", label: "甲", position: { x: 0, y: 0 } }))
    store.addNode(buildNodeRecord({ id: "b", type: "process", label: "乙", position: { x: 0, y: 0 } }))
    const Root = defineComponent({
      setup() {
        runtime = provideNodeKit(createDefaultNodeKit(), selectedNodeId)
        return () =>
          h("div", [
            h("section", { id: "a" }, [h(NodeHost, nodeProps("a", "process"))]),
            h("section", { id: "b" }, [h(NodeHost, nodeProps("b", "process"))])
          ])
      }
    })
    wrapper = mount(Root)
    return { store, w: wrapper }
  }

  it("双击名字进入 rename 模式，回车提交后退出", async () => {
    const { store, w } = mountTwo()
    await w.find('#a span[title="双击改名"]').trigger("dblclick")
    expect(runtime.modes.current.value).toEqual({ nodeId: "a", mode: "rename" })

    await w.find("#a input").setValue("甲二")
    await w.find("#a input").trigger("keydown", { key: "Enter" })

    expect(store.nodeById.get("a")?.metadata.label).toBe("甲二")
    expect(runtime.modes.current.value).toBeNull()
  })

  it("Esc 取消：不写文档，模式以 cancel 退出", async () => {
    const { store, w } = mountTwo()
    const exits: string[] = []
    runtime.kit.on("mode:exit", ({ reason }) => exits.push(reason))

    await w.find('#a span[title="双击改名"]').trigger("dblclick")
    await w.find("#a input").setValue("不要了")
    await w.find("#a input").trigger("keydown", { key: "Escape" })

    expect(store.nodeById.get("a")?.metadata.label).toBe("甲")
    expect(exits).toEqual(["cancel"])
  })

  it("开始改另一个节点的名字：上一个的草稿按 blur 规矩提交，输入框收起", async () => {
    const { store, w } = mountTwo()
    await w.find('#a span[title="双击改名"]').trigger("dblclick")
    await w.find("#a input").setValue("甲二")

    await w.find('#b span[title="双击改名"]').trigger("dblclick")

    expect(store.nodeById.get("a")?.metadata.label).toBe("甲二")
    expect(w.find("#a input").exists()).toBe(false)
    expect(w.find("#b input").exists()).toBe(true)
    expect(runtime.modes.current.value).toEqual({ nodeId: "b", mode: "rename" })
  })

  it("选中别的节点：正在改的名字以 preempted 退出并提交", async () => {
    const { store, w } = mountTwo()
    await w.find('#a span[title="双击改名"]').trigger("dblclick")
    await w.find("#a input").setValue("甲二")

    selectedNodeId.value = "b"
    await nextTick()
    await nextTick()

    expect(runtime.modes.current.value).toBeNull()
    expect(store.nodeById.get("a")?.metadata.label).toBe("甲二")
    expect(w.find("#a input").exists()).toBe(false)
  })
})
