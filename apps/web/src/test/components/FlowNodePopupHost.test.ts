import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import type { FlowDetail } from "@shadecn/shared/canvas"
import { GRAPH_SCHEMA_VERSION } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import { createNodeKitRuntime, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"
import type { NodeEventSource } from "@/components/flow/node-kit/protocol"
import { useFlowStore } from "@/stores/flow"

/**
 * 节点的弹出编辑（`FlowNodePopupHost` + 文本节点的 `TextEditorPanel`，docs/21 §4.10）：
 * 打开 / 关闭的几种方式、一次弹出编辑 = 一次提交、画布快捷键让路、节点被删就收起。
 */

let runtime: NodeKitRuntime

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({ nodeKit: runtime, store: useFlowStore() })
}))

const { default: FlowNodePopupHost } = await import("@/components/flow/popup/FlowNodePopupHost.vue")
const { useFlowShortcuts } = await import("@/composables/flow/useFlowShortcuts")

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
    createdById: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: { schemaVersion: GRAPH_SCHEMA_VERSION, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], meta: {} },
    userState: {}
  }
}

function sourceOf(id: string, type: string): NodeEventSource {
  const source = { id, type, emit: (event: never, payload: never) => runtime.kit.emit(event, payload, source as never) }
  return source as unknown as NodeEventSource
}

const canvasUndo = vi.fn()
let wrapper: VueWrapper | null = null

async function mountHost() {
  const Host = defineComponent({
    setup() {
      useFlowShortcuts({
        store: { undo: canvasUndo, redo: vi.fn() },
        canvas: { deleteSelection: vi.fn() },
        selection: { selectedNodeId: ref("t1") },
        nodeKit: runtime,
        document: { flushBeforeLeave: async () => {} }
      } as never)
      return () => h(FlowNodePopupHost)
    }
  })
  wrapper = mount(Host, { attachTo: document.body })
  await flushPromises()
}

async function openEditor(id = "t1", type = "text") {
  runtime.kit.emit("text:open-editor", {}, sourceOf(id, type))
  await flushPromises()
}

const popup = () => document.querySelector('[data-testid="text-editor-popup"]') as HTMLElement | null
const input = () => document.querySelector('[data-testid="text-editor-input"]') as HTMLTextAreaElement

async function type(value: string) {
  input().value = value
  input().dispatchEvent(new Event("input"))
  await nextTick()
}

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const text = () => useFlowStore().nodeById.get("t1")?.data.text

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ""
  runtime = createNodeKitRuntime(createDefaultNodeKit())
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  store.addNode(buildNodeRecord({ id: "t1", type: "text", label: "说明", position: { x: 0, y: 0 } }))
  store.writeNode("t1", "data", { set: { text: "原文" } })
  store.addNode(buildNodeRecord({ id: "img", type: "image", label: "图", position: { x: 0, y: 0 } }))
  canvasUndo.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("弹出编辑的宿主", () => {
  it("关着不挂；打开后遮罩 + 面板，标题是节点名，编辑框里是 Markdown 原文且拿到焦点", async () => {
    await mountHost()
    expect(popup()).toBeNull()
    await openEditor()
    expect(popup()?.getAttribute("data-role")).toBe("node-popup-backdrop")
    expect(document.querySelector('[data-testid="node-popup-title"]')?.textContent).toBe("说明")
    expect(input().value).toBe("原文")
    expect(document.activeElement).toBe(input())
  })

  it("别的类型发的同名事件不归它管", async () => {
    await mountHost()
    await openEditor("img", "image")
    expect(popup()).toBeNull()
  })

  it("预览实时按 Markdown 渲染草稿；关闭前文档不变，点「完成」提交一次", async () => {
    await mountHost()
    await openEditor()
    await type("# 新标题\n\n正文")
    expect(document.querySelector('[data-testid="text-editor-preview"] h1')?.textContent).toBe("新标题")
    expect(text()).toBe("原文")
    ;(document.querySelector('[data-testid="node-popup-close"]') as HTMLElement).click()
    await flushPromises()
    expect(popup()).toBeNull()
    expect(text()).toBe("# 新标题\n\n正文")
    // 一次弹出编辑 = 一条撤销
    useFlowStore().undo()
    expect(text()).toBe("原文")
  })

  it("标题栏里的「预览」开关：关掉后只剩编辑区，草稿不丢、焦点留在编辑框；再打开时记得上次的状态", async () => {
    await mountHost()
    await openEditor()
    const toggle = () => document.querySelector('[data-testid="node-popup-panel"] header [data-testid="text-editor-preview-toggle"]') as HTMLElement
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    await type("**草稿**")
    toggle().click()
    await nextTick()
    expect(document.querySelector('[data-testid="text-editor-preview"]')).toBeNull()
    expect(input().value).toBe("**草稿**")
    expect(document.activeElement).toBe(input())
    expect(toggle().getAttribute("aria-pressed")).toBe("false")

    press(input(), { key: "Escape" })
    await flushPromises()
    await openEditor()
    expect(document.querySelector('[data-testid="text-editor-preview"]')).toBeNull()
    toggle().click()
    await nextTick()
    expect(document.querySelector('[data-testid="text-editor-preview"] strong')?.textContent).toBe("草稿")
  })

  it("编辑框里按 Esc 直接关闭并提交（不丢字）", async () => {
    await mountHost()
    await openEditor()
    await type("改了")
    press(input(), { key: "Escape" })
    await flushPromises()
    expect(popup()).toBeNull()
    expect(text()).toBe("改了")
  })

  it("点遮罩关闭；在面板里按下、遮罩上松开不算", async () => {
    await mountHost()
    await openEditor()
    const panel = document.querySelector('[data-testid="node-popup-panel"]')!
    panel.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    popup()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await flushPromises()
    expect(popup()).not.toBeNull()

    popup()!.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    popup()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await flushPromises()
    expect(popup()).toBeNull()
  })

  it("开着时画布快捷键让路（Ctrl+Z 不撤画布）；关上后恢复", async () => {
    await mountHost()
    await openEditor()
    press(popup()!, { key: "z", ctrlKey: true })
    expect(canvasUndo).not.toHaveBeenCalled()
    press(popup()!, { key: "Escape" })
    await flushPromises()
    press(document.body, { key: "z", ctrlKey: true })
    expect(canvasUndo).toHaveBeenCalledTimes(1)
  })

  it("开着的节点被删了就收起来，不再写它", async () => {
    await mountHost()
    await openEditor()
    await type("写到一半")
    useFlowStore().removeElements(["t1"], [])
    await flushPromises()
    expect(popup()).toBeNull()
    expect(useFlowStore().nodeById.has("t1")).toBe(false)
  })
})
