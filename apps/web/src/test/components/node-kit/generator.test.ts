import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"

import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import { provideNodeKit, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"
import { useFlowStore } from "@/stores/flow"

/**
 * 第一批新能力（REQ-NODEKIT §6）：生图节点的底部输入框（按类型注册）、`runnable` 把提交转成运行请求、
 * `output-preview` 的产出列表与侧边大图。三方互不 import，只靠事件和注册表串起来。
 */

const selectedNodeId = ref<string | null>(null)

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly: vi.fn(),
      addConnectedNode: vi.fn(),
      deleteNode: vi.fn(),
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

let wrapper: VueWrapper | null = null
let runtime: NodeKitRuntime

function mountNode(record: FlowNodeRecord) {
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  store.addNode(record)
  const Root = defineComponent({
    setup() {
      runtime = provideNodeKit(createDefaultNodeKit(), selectedNodeId)
      return () => h(NodeHost, { id: record.id, type: record.type, selected: false, data: {} } as never)
    }
  })
  wrapper = mount(Root, { attachTo: document.body })
  return { store, w: wrapper }
}

function imageConfig(patch: Partial<FlowNodeRecord> = {}): FlowNodeRecord {
  return {
    ...buildNodeRecord({ id: "gen", type: "image-config", label: "生图", position: { x: 0, y: 0 } }),
    ...patch
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  selectedNodeId.value = "gen"
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("生图节点的底部输入框", () => {
  it("选中时出现；写字进入 edit-prompt 模式、上方工具条收起", async () => {
    const { w } = mountNode(imageConfig())
    await nextTick()
    const composer = w.find('[data-testid="prompt-composer"]')
    expect(composer.exists()).toBe(true)
    expect(w.find('[data-node-slot="toolbar"]').exists()).toBe(true)

    await composer.trigger("focus")
    expect(runtime.modes.current.value).toEqual({ nodeId: "gen", mode: "edit-prompt" })
    expect(w.find('[data-node-slot="toolbar"]').exists()).toBe(false)
  })

  it("回车：写回 data.prompt，发 composer:submit，runnable 接住转成 node:run", async () => {
    const { store, w } = mountNode(imageConfig())
    await nextTick()
    const submits: string[] = []
    const runs: (string | undefined)[] = []
    runtime.kit.on("composer:submit", ({ text }) => submits.push(text))
    runtime.kit.on("node:run", ({ prompt }) => runs.push(prompt))

    const composer = w.find('[data-testid="prompt-composer"]')
    await composer.trigger("focus")
    await composer.setValue("一只橘猫")
    await composer.trigger("keydown", { key: "Enter" })

    expect(store.nodeById.get("gen")?.data.prompt).toBe("一只橘猫")
    expect(submits).toEqual(["一只橘猫"])
    expect(runs).toEqual(["一只橘猫"])
    expect(runtime.modes.current.value).toBeNull()
  })

  it("输入法组字时的回车、Shift+回车都不提交", async () => {
    const { store, w } = mountNode(imageConfig())
    await nextTick()
    const submit = vi.fn()
    runtime.kit.on("composer:submit", submit)

    const composer = w.find('[data-testid="prompt-composer"]')
    await composer.trigger("focus")
    await composer.setValue("yi zhi")
    await composer.trigger("keydown", { key: "Enter", isComposing: true })
    await composer.trigger("keydown", { key: "Enter", shiftKey: true })

    expect(submit).not.toHaveBeenCalled()
    expect(store.nodeById.get("gen")?.data.prompt).toBe("")
  })

  it("Esc 丢掉草稿；失焦只写回、不提交", async () => {
    const { store, w } = mountNode(imageConfig())
    await nextTick()
    const submit = vi.fn()
    runtime.kit.on("composer:submit", submit)
    const composer = w.find('[data-testid="prompt-composer"]')

    await composer.trigger("focus")
    await composer.setValue("不要了")
    await composer.trigger("keydown", { key: "Escape" })
    expect(store.nodeById.get("gen")?.data.prompt).toBe("")

    await composer.trigger("focus")
    await composer.setValue("先写着")
    await composer.trigger("blur")
    expect(store.nodeById.get("gen")?.data.prompt).toBe("先写着")
    expect(submit).not.toHaveBeenCalled()
  })

  it("空提示词提交：写回了，但不算一次运行请求", async () => {
    const { w } = mountNode(imageConfig({ data: { prompt: "旧的" } }))
    await nextTick()
    const run = vi.fn()
    runtime.kit.on("node:run", run)

    const composer = w.find('[data-testid="prompt-composer"]')
    await composer.trigger("focus")
    await composer.setValue("   ")
    await composer.trigger("keydown", { key: "Enter" })

    expect(run).not.toHaveBeenCalled()
  })

  it("选中别的节点：正在写的提示词按失焦规矩写回，模式退出", async () => {
    const { store, w } = mountNode(imageConfig())
    await nextTick()
    const composer = w.find('[data-testid="prompt-composer"]')
    await composer.trigger("focus")
    await composer.setValue("写到一半")

    selectedNodeId.value = "other"
    await nextTick()
    await nextTick()

    expect(store.nodeById.get("gen")?.data.prompt).toBe("写到一半")
    expect(runtime.modes.current.value).toBeNull()
  })
})

describe("产出预览", () => {
  const withImage = () =>
    imageConfig({ runtime: { status: "completed", outputs: { image: { url: "https://x/full.png", coverUrl: "https://x/cover.png" } } } })

  it("没有产出：footer 不挂列表，工具条上没有「展开预览」", async () => {
    const { w } = mountNode(imageConfig())
    await nextTick()
    expect(w.find('[data-testid="generic-node-outputs"]').exists()).toBe(false)
    expect(w.find('[data-node-action="output-preview.open"]').exists()).toBe(false)
  })

  it("有图：footer 画封面缩略图；展开后右侧出原图，按钮换成「收起预览」", async () => {
    const { w } = mountNode(withImage())
    await nextTick()
    expect(w.find('[data-testid="generic-node-outputs"] img').attributes("src")).toBe("https://x/cover.png")
    expect(w.find('[data-testid="output-side-preview"]').exists()).toBe(false)

    await w.find('[data-node-action="output-preview.open"]').trigger("click")
    await flushPromises()
    expect(w.find('[data-testid="output-side-preview"] img').attributes("src")).toBe("https://x/full.png")
    expect(w.find('[data-node-action="output-preview.open"]').exists()).toBe(false)

    await w.find('[data-node-action="output-preview.close"]').trigger("click")
    await flushPromises()
    expect(w.find('[data-testid="output-side-preview"]').exists()).toBe(false)
    expect(w.find('[data-node-action="output-preview.open"]').exists()).toBe(true)
  })
})
