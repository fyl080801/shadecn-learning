import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as ops from "@shadecn/shared/flow-ops"
import { defineComponent, h, nextTick, ref, shallowRef } from "vue"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"

import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import { provideNodeKit, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"
import { createNodeKit, type NodeKit } from "@/components/flow/node-kit/registry"
import { editPromptFeature } from "@/components/flow/composer/prompt"
import { FLOW_NODE_TYPES, STANDARD_NODE_FEATURES } from "@/components/flow/node-types"
import { connectableFeature, statusFeature } from "@/components/flow/node-kit/features/display"
import { deleteFeature, duplicateFeature } from "@/components/flow/node-kit/features/edit-actions"
import { outputPreviewFeature } from "@/components/flow/node-kit/features/output-preview"
import { renameFeature } from "@/components/flow/node-kit/features/rename"
import { runnableFeature } from "@/components/flow/node-kit/features/runnable"
import PromptInput from "@/components/prompt-input/PromptInput.vue"
import { useFlowStore } from "@/stores/flow"

/**
 * 底部输入框（REQ-NODEKIT §6，按类型注册）：文本 / 图片 / 视频 / 导演台各有一个；文本有了正文就收起，
 * 图片 / 视频看形态（generate 有、asset 没有），导演台一直有；
 * 提交只写回 `data.prompt` 并发 `composer:submit`，眼下没有谁接它（四种类型都没启用 `runnable`）。
 *
 * `runnable`（把提交转成运行请求）和 `output-preview`（产出列表与侧边大图）仍是登记着的通用能力，
 * 只是默认类型都没启用 —— 在测试里给 `image` 单独装一份启用了它们的注册表来测。三方互不 import，只靠事件和注册表串起来。
 */

const selectedNodeId = ref<string | null>(null)

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      selectOnly: vi.fn(),
      addConnectedNode: vi.fn(),
      deleteNode: vi.fn(),
      duplicateNode: vi.fn(),
      growMenu: shallowRef(null),
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

let wrapper: VueWrapper | null = null

// jsdom 的 Range 没有几何信息；PromptInput 聚焦后要拿光标位置来滚动 / 定位弹出层
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

/** 底部输入框是 PromptInput：事件落在它的 contenteditable 上，写字 = 它发的 update:modelValue */
function composerOf(w: VueWrapper) {
  const editable = w.get('[data-testid="prompt-composer"] [data-cy="prompt-input"]')
  return {
    focus: () => editable.trigger("focus"),
    blur: () => editable.trigger("blur"),
    key: (key: string, init: KeyboardEventInit = {}) => editable.trigger("keydown", { key, ...init }),
    type: async (text: string) => {
      w.findComponent(PromptInput).vm.$emit("update:modelValue", text)
      await nextTick()
    }
  }
}
let runtime: NodeKitRuntime

function mountNode(record: FlowNodeRecord, kit: NodeKit = createDefaultNodeKit()) {
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  store.addNode(record)
  const Root = defineComponent({
    setup() {
      runtime = provideNodeKit(kit, selectedNodeId)
      return () => h(NodeHost, { id: record.id, type: record.type, selected: false, data: {} } as never)
    }
  })
  wrapper = mount(Root, { attachTo: document.body })
  return { store, w: wrapper }
}

function nodeOf(type: string, patch: Partial<FlowNodeRecord> = {}): FlowNodeRecord {
  return {
    ...buildNodeRecord({ id: "gen", type, label: "节点", position: { x: 0, y: 0 } }),
    ...patch
  }
}

const imageNode = (patch: Partial<FlowNodeRecord> = {}) => nodeOf("image", patch)

/**
 * 一份「图片节点启用了 `runnable` + `output-preview`」的注册表 —— 默认类型都没启用这两个通用能力，
 * 测它们得自己装。部件（底部输入框）和外观照搬默认的 `image` 声明。
 */
function kitWithRunnableImage(): NodeKit {
  const kit = createNodeKit()
  for (const feature of [
    renameFeature,
    duplicateFeature,
    deleteFeature,
    connectableFeature,
    statusFeature,
    editPromptFeature,
    runnableFeature,
    outputPreviewFeature
  ]) {
    kit.registerFeature(feature)
  }
  const image = FLOW_NODE_TYPES.image!
  kit.registerType({
    type: "image",
    features: [...STANDARD_NODE_FEATURES, "edit-prompt", "runnable", "output-preview"],
    view: image.view,
    parts: image.parts
  })
  kit.assertValid()
  return kit
}

beforeEach(() => {
  setActivePinia(createPinia())
  selectedNodeId.value = "gen"
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("图片节点的底部输入框", () => {
  it("选中时出现；写字进入 edit-prompt 模式、上方工具条仍然显示", async () => {
    const { w } = mountNode(imageNode())
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(true)
    const composer = composerOf(w)
    expect(w.find('[data-node-slot="toolbar"]').exists()).toBe(true)

    await composer.focus()
    expect(runtime.modes.current.value).toEqual({ nodeId: "gen", mode: "edit-prompt" })
    expect(w.find('[data-node-slot="toolbar"]').exists()).toBe(true)
  })

  it("回车：写回 data.prompt，发 composer:submit；没有谁把它转成运行请求（图片没启用 runnable）", async () => {
    const { store, w } = mountNode(imageNode())
    await nextTick()
    const submits: string[] = []
    const runs: (string | undefined)[] = []
    runtime.kit.on("composer:submit", ({ text }) => submits.push(text))
    runtime.kit.on("node:run", ({ prompt }) => runs.push(prompt))

    const composer = composerOf(w)
    await composer.focus()
    await composer.type("一只橘猫")
    await composer.key("Enter")

    expect(store.nodeById.get("gen")?.data.prompt).toBe("一只橘猫")
    expect(submits).toEqual(["一只橘猫"])
    expect(runs).toEqual([])
    expect(runtime.modes.current.value).toBeNull()
  })

  it("输入法组字时的回车、Shift+回车都不提交", async () => {
    const { store, w } = mountNode(imageNode())
    await nextTick()
    const submit = vi.fn()
    runtime.kit.on("composer:submit", submit)

    const composer = composerOf(w)
    await composer.focus()
    await composer.type("yi zhi")
    await composer.key("Enter", { isComposing: true })
    await composer.key("Enter", { shiftKey: true })

    expect(submit).not.toHaveBeenCalled()
    expect(store.nodeById.get("gen")?.data.prompt).toBeUndefined()
  })

  it("Esc 丢掉草稿；失焦只写回、不提交", async () => {
    const { store, w } = mountNode(imageNode())
    await nextTick()
    const submit = vi.fn()
    runtime.kit.on("composer:submit", submit)
    const composer = composerOf(w)

    await composer.focus()
    await composer.type("不要了")
    await composer.key("Escape")
    expect(store.nodeById.get("gen")?.data.prompt).toBeUndefined()

    await composer.focus()
    await composer.type("先写着")
    await composer.blur()
    expect(store.nodeById.get("gen")?.data.prompt).toBe("先写着")
    expect(submit).not.toHaveBeenCalled()
  })

  it("启用了 runnable 的类型：非空提交转成 node:run", async () => {
    const { w } = mountNode(imageNode(), kitWithRunnableImage())
    await nextTick()
    const runs: (string | undefined)[] = []
    runtime.kit.on("node:run", ({ prompt }) => runs.push(prompt))

    const composer = composerOf(w)
    await composer.focus()
    await composer.type("一只橘猫")
    await composer.key("Enter")

    expect(runs).toEqual(["一只橘猫"])
  })

  it("启用了 runnable 的类型：空提示词提交写回了，但不算一次运行请求", async () => {
    const { w } = mountNode(imageNode({ data: { prompt: "旧的" } }), kitWithRunnableImage())
    await nextTick()
    const run = vi.fn()
    runtime.kit.on("node:run", run)

    const composer = composerOf(w)
    await composer.focus()
    await composer.type("   ")
    await composer.key("Enter")

    expect(run).not.toHaveBeenCalled()
  })

  it("选中别的节点：正在写的提示词按失焦规矩写回，模式退出", async () => {
    const { store, w } = mountNode(imageNode())
    await nextTick()
    const composer = composerOf(w)
    await composer.focus()
    await composer.type("写到一半")

    selectedNodeId.value = "other"
    await nextTick()
    await nextTick()

    expect(store.nodeById.get("gen")?.data.prompt).toBe("写到一半")
    expect(runtime.modes.current.value).toBeNull()
  })
})

describe("各类型的底部输入框：文本有了正文就收起，图片 / 视频看形态，导演台一直有", () => {
  it("文本：没内容时选中有输入框，填上正文就收起", async () => {
    const { store, w } = mountNode(nodeOf("text"))
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(true)

    store.writeNode("gen", "data", { set: { text: "已经写了" } })
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(false)
  })

  it("图片 / 视频：generate 有了图输入框照旧在；成了素材（asset）就没有", async () => {
    for (const type of ["image", "video"]) {
      setActivePinia(createPinia())
      const { store, w } = mountNode(nodeOf(type))
      await nextTick()
      expect(w.find('[data-testid="prompt-composer"]').exists(), type).toBe(true)

      store.mutate((ctx) => ops.writeNodeFields(ctx, "gen", "data", { set: { src: "https://x/a" } }))
      await nextTick()
      expect(w.find('[data-testid="prompt-composer"]').exists(), type).toBe(true)

      store.attachAsset("gen", { src: "https://x/a" })
      await nextTick()
      expect(w.find('[data-testid="prompt-composer"]').exists(), type).toBe(false)
      w.unmount()
      wrapper = null
    }
  })

  it("文本：双击进入正文编辑时收起输入框，退出编辑后（仍为空）重新出现", async () => {
    const { w } = mountNode(nodeOf("text"))
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(true)

    await w.find("[data-status]").trigger("dblclick")
    await nextTick()
    expect(runtime.modes.current.value).toEqual({ nodeId: "gen", mode: "edit-body" })
    expect(w.find('[data-testid="text-body-input"]').exists()).toBe(true)
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(false)

    runtime.modes.exit("cancel")
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(true)
  })

  it("导演台：没有「内容」这回事，输入框一直在", async () => {
    const { w } = mountNode(nodeOf("director", { data: { src: "https://x/a.png", text: "x" } }))
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(true)
  })

  it("没选中、也没在写：没有输入框（浮层不挂）", async () => {
    selectedNodeId.value = null
    const { w } = mountNode(imageNode())
    await nextTick()
    expect(w.find('[data-testid="prompt-composer"]').exists()).toBe(false)
  })
})

describe("产出预览（图片节点启用 output-preview 时）", () => {
  const withImage = () =>
    imageNode({ runtime: { status: "completed", outputs: { image: { url: "https://x/full.png", coverUrl: "https://x/cover.png" } } } })

  it("没有产出：footer 不挂列表，工具条上没有「展开预览」", async () => {
    const { w } = mountNode(imageNode(), kitWithRunnableImage())
    await nextTick()
    expect(w.find('[data-testid="generic-node-outputs"]').exists()).toBe(false)
    expect(w.find('[data-node-action="output-preview.open"]').exists()).toBe(false)
  })

  it("有图：footer 画封面缩略图；展开后右侧出原图，按钮换成「收起预览」", async () => {
    const { w } = mountNode(withImage(), kitWithRunnableImage())
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
