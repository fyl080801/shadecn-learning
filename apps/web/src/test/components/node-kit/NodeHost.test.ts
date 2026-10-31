import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { GRAPH_SCHEMA_VERSION } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"

import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import { provideNodeKit, useNodePart, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import {
  defineNodeAction,
  defineNodeFeature,
  defineNodeMode,
  defineNodePart,
  type NodePartContext
} from "@/components/flow/node-kit/protocol"
import { createNodeKit, type NodeKit } from "@/components/flow/node-kit/registry"
import { useFlowStore } from "@/stores/flow"

/**
 * 节点宿主：按注册表把部件 / 动作挂到各个区域，并按宿主的几何约定决定框外区域露不露出。
 *
 * 数据走真的 store + Y.Doc；Vue Flow 要画布上下文的组件换成替身。NodeToolbar 的替身**总会渲染一个标记**
 * （带位置和可见性），这样「没挂这个浮层」和「挂了但没露出」在 DOM 上分得开。
 */

const selectedNodeId = ref<string | null>(null)
const boxSelecting = ref(false)

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly: vi.fn(),
      addConnectedNode: vi.fn(),
      deleteNode: vi.fn(),
      duplicateNode: vi.fn(),
      isValidConnection: () => true,
      boxSelecting
    },
    presence: { occupantsOf: () => [] },
    selection: { selectedNodeId },
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
    props: { isVisible: Boolean, position: { type: String, default: "" } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          { "data-stub": "toolbar", "data-position": props.position, "data-visible": String(props.isVisible) },
          props.isVisible ? slots.default?.() : []
        )
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

/** 一个只渲染自己 id 的部件，顺便把拿到的上下文交出来 */
const seen: NodePartContext[] = []
function marker(text: string) {
  return defineComponent({
    setup() {
      seen.push(useNodePart())
      return () => h("span", { "data-marker": text }, text)
    }
  })
}

const Icon = defineComponent({ render: () => h("i") })

/**
 * 探针部件：挂在 header 里、什么都不画，只把宿主 provide 的上下文交出来 ——
 * 等同于「某个部件在里面调 `ctx.slots.open` / `ctx.mode.enter`」。
 */
let probed: NodePartContext | null = null
const probe = defineNodePart({
  id: "probe",
  slot: "header",
  match: {},
  component: defineComponent({
    setup() {
      probed = useNodePart()
      return () => null
    }
  })
})

function hostCtx(): NodePartContext {
  if (!probed) throw new Error("探针没挂上")
  return probed
}

let wrapper: VueWrapper | null = null
let runtime: NodeKitRuntime

function mountHost(kit: NodeKit, id = "n1", type = "image") {
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  store.addNode(buildNodeRecord({ id, type, label: `节点 ${id}`, position: { x: 0, y: 0 } }))

  const Root = defineComponent({
    setup() {
      runtime = provideNodeKit(kit, selectedNodeId)
      return () => h(NodeHost, { id, type, selected: false, data: {} } as never)
    }
  })
  wrapper = mount(Root)
  return wrapper
}

const markers = (w: VueWrapper) => w.findAll("[data-marker]").map((item) => item.text())
const outer = (w: VueWrapper, position: string) =>
  w.findAll('[data-stub="toolbar"]').filter((item) => item.attributes("data-position") === position)
/** 某个位置上第一个浮层的可见性；没挂就是 undefined */
const visibility = (w: VueWrapper, position: string) => outer(w, position)[0]?.attributes("data-visible")

beforeEach(() => {
  setActivePinia(createPinia())
  selectedNodeId.value = null
  boxSelecting.value = false
  seen.length = 0
  probed = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("NodeHost 的区域", () => {
  it("卡片内的区域按解析顺序挂部件；when 为假的不挂；部件拿到的是这个节点的上下文", async () => {
    const kit = createNodeKit()
    const hidden = ref(true)
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        parts: [
          defineNodePart({ id: "b", slot: "badge", component: marker("badge") }),
          defineNodePart({ id: "h", slot: "header", component: marker("header") }),
          defineNodePart({ id: "f2", slot: "footer", order: 200, component: marker("footer-2") }),
          defineNodePart({ id: "f1", slot: "footer", component: marker("footer-1") }),
          defineNodePart({ id: "x", slot: "footer", component: marker("conditional"), when: () => !hidden.value })
        ]
      })
    )
    kit.registerType({ type: "image", features: ["f"] })

    const w = mountHost(kit)
    expect(markers(w)).toEqual(["badge", "header", "footer-1", "footer-2"])
    expect(seen.every((ctx) => ctx.id === "n1" && ctx.type === "image")).toBe(true)

    hidden.value = false
    await nextTick()
    expect(markers(w)).toContain("conditional")
  })

  it("没给这个类型注册底部输入框 / 侧边预览：选中了也不挂那两个浮层", async () => {
    const kit = createNodeKit()
    kit.registerType({ type: "text", features: [] })

    const w = mountHost(kit, "n1", "text")
    selectedNodeId.value = "n1"
    await nextTick()

    expect(outer(w, "bottom")).toHaveLength(0)
    expect(outer(w, "right")).toHaveLength(0)
  })

  it("类型在工具条区域什么都没有：选中了也不挂工具条浮层；名字那一行（在场头像）照常挂", async () => {
    const kit = createNodeKit()
    kit.registerType({ type: "text", features: [] })

    const w = mountHost(kit, "n1", "text")
    selectedNodeId.value = "n1"
    await nextTick()

    expect(outer(w, "top")).toHaveLength(1)
    expect(w.find('[data-node-slot="label"]').exists()).toBe(true)
    expect(w.find('[data-node-slot="toolbar"]').exists()).toBe(false)
  })

  it("类型图标画在名字左边；外观没给图标就不画", () => {
    const kit = createNodeKit()
    kit.registerType({
      type: "text",
      features: [],
      view: { icon: defineComponent({ setup: () => () => h("svg", { "data-icon": "text" }) }) },
      parts: [defineNodePart({ id: "title", slot: "label", component: marker("title") })]
    })
    kit.registerType({ type: "image", features: [] })

    const label = mountHost(kit, "n1", "text").find('[data-node-slot="label"]')
    const children = label.element.children
    expect(children[0]?.getAttribute("data-icon")).toBe("text")
    expect(children[1]?.getAttribute("data-marker")).toBe("title")

    expect(mountHost(kit, "n2", "image").find("[data-node-type-icon]").exists()).toBe(false)
  })

  it("能力给根元素加的 class 合到宿主根上", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "glow", rootClass: (ctx) => ctx.type === "image" && "ring-4" }))
    kit.registerType({ type: "image", features: ["glow"] })

    const w = mountHost(kit)
    expect(w.find('[data-status]').classes()).toContain("ring-4")
  })

  it("底部输入框：单独选中时露出，拉框时不露出，没选中时挂着但不露出", async () => {
    const kit = createNodeKit()
    kit.registerType({
      type: "image",
      features: [],
      parts: [defineNodePart({ id: "composer", slot: "composer", component: marker("composer") })]
    })

    const w = mountHost(kit)
    expect(visibility(w, "bottom")).toBe("false")

    selectedNodeId.value = "n1"
    await nextTick()
    expect(visibility(w, "bottom")).toBe("true")
    expect(markers(w)).toContain("composer")

    boxSelecting.value = true
    await nextTick()
    expect(visibility(w, "bottom")).toBe("false")
  })

  it("侧边预览只在被要求时露出（slots.open / close）", async () => {
    const kit = createNodeKit()
    kit.registerType({
      type: "image",
      features: [],
      parts: [defineNodePart({ id: "preview", slot: "side", component: marker("preview") })]
    })
    const events: string[] = []
    kit.on("slot:open", ({ slot }) => events.push(`open ${slot}`))
    kit.on("slot:close", ({ slot }) => events.push(`close ${slot}`))
    kit.registerPart(probe)

    const w = mountHost(kit)
    selectedNodeId.value = "n1"
    await nextTick()
    // 选中不够：侧边预览要有人明确要求
    expect(visibility(w, "right")).toBe("false")
    expect(markers(w)).not.toContain("preview")

    hostCtx().slots.open("side")
    await nextTick()
    expect(visibility(w, "right")).toBe("true")
    expect(markers(w)).toContain("preview")

    hostCtx().slots.close("side")
    await nextTick()
    expect(visibility(w, "right")).toBe("false")
    expect(events).toEqual(["open side", "close side"])
  })

  it("模式要求露出 / 收起：edit-prompt 露出底部输入框、收起工具条；选中别的节点后恢复", async () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "prompt",
        modes: [defineNodeMode({ id: "edit-prompt", reveal: ["composer"], conceal: ["toolbar"] })],
        actions: [defineNodeAction({ id: "run", slot: "toolbar", icon: Icon, label: "运行", run: () => undefined })]
      })
    )
    kit.registerType({
      type: "image",
      features: ["prompt"],
      parts: [defineNodePart({ id: "composer", slot: "composer", component: marker("composer") })]
    })
    kit.registerPart(probe)

    const w = mountHost(kit)
    selectedNodeId.value = "n1"
    await nextTick()
    expect(outer(w, "top").some((item) => item.attributes("data-visible") === "true" && item.find("button").exists())).toBe(true)

    expect(hostCtx().mode.enter("edit-prompt")).toBe(true)
    await nextTick()
    // 工具条收起：上方只剩常开的名字那一条，里面没有按钮
    expect(outer(w, "top").filter((item) => item.attributes("data-visible") === "true")).toHaveLength(1)
    expect(visibility(w, "bottom")).toBe("true")

    selectedNodeId.value = "other"
    await nextTick()
    expect(runtime.modes.current.value).toBeNull()
    expect(visibility(w, "bottom")).toBe("false")
  })
})

describe("NodeHost 的动作", () => {
  it("工具条区域的动作按解析顺序排；when 为假不出现，enabled 为假置灰", async () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        actions: [
          defineNodeAction({ id: "run", slot: "toolbar", icon: Icon, label: "运行", run: () => undefined }),
          defineNodeAction({ id: "off", slot: "toolbar", icon: Icon, label: "禁用", enabled: () => false, run: () => undefined }),
          defineNodeAction({ id: "gone", slot: "toolbar", icon: Icon, label: "不在", when: () => false, run: () => undefined })
        ]
      })
    )
    kit.registerType({ type: "image", features: ["f"] })

    const w = mountHost(kit)
    selectedNodeId.value = "n1"
    await nextTick()

    const titles = w.findAll("button").map((item) => item.attributes("title"))
    expect(titles).toEqual(["运行", "禁用"])
    expect(w.find('[data-node-action="off"]').attributes("disabled")).toBeDefined()
  })

  it("点动作：以节点上下文调 run，前后各发 action:invoke / action:done", async () => {
    const kit = createNodeKit()
    const run = vi.fn()
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        actions: [defineNodeAction({ id: "run", slot: "footer", icon: Icon, label: "运行", run })]
      })
    )
    kit.registerType({ type: "image", features: ["f"] })
    const events: string[] = []
    kit.on("action:invoke", ({ action }) => events.push(`invoke ${action}`))
    kit.on("action:done", ({ action, error }) => events.push(`done ${action} ${error ? "error" : "ok"}`))

    const w = mountHost(kit)
    await w.find('[data-node-action="run"]').trigger("click")
    await flushPromises()

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }))
    expect(events).toEqual(["invoke run", "done run ok"])
  })

  it("动作抛错：action:done 带上错误，不往外抛", async () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        actions: [
          defineNodeAction({
            id: "bad",
            slot: "footer",
            icon: Icon,
            label: "坏",
            run: () => {
              throw new Error("boom")
            }
          })
        ]
      })
    )
    kit.registerType({ type: "image", features: ["f"] })
    const done = vi.fn()
    kit.on("action:done", done)

    const w = mountHost(kit)
    await w.find('[data-node-action="bad"]').trigger("click")
    await flushPromises()

    expect(done).toHaveBeenCalledWith({ action: "bad", error: expect.any(Error) }, expect.anything())
  })
})
