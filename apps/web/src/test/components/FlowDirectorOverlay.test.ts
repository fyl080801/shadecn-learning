import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, defineComponent, h, ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import type { AgentConversationSummary, AgentSessionView } from "@shadecn/shared/agent"
import type { FlowDetail, ProjectSummary } from "@shadecn/shared/canvas"
import { GRAPH_SCHEMA_VERSION } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import PromptInput from "@/components/prompt-input/PromptInput.vue"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createNodeKitRuntime, type NodeKitRuntime } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"
import type { NodeEventSource } from "@/components/flow/node-kit/protocol"
import { useFlowStore } from "@/stores/flow"

/**
 * 全屏导演台（`FlowDirectorOverlay`）：键盘路由、对话面板选会话、自动带上这个导演台的提及、节点底部输入框发起的会话。
 *
 * 真的挂全屏层、工作区、对话面板（shadcn-vue / PromptInput 都是真的），舞台换成替身（jsdom 没有 WebGL）——
 * 替身只记下全屏层路由给它的快捷键。接口和编辑器上下文打桩。
 */

const runShortcut = vi.fn<(action: string) => boolean>(() => true)
vi.mock("@/components/director", () => ({
  DirectorStage: defineComponent({
    name: "DirectorStageStub",
    props: { nodeId: String, agentEditing: Boolean },
    setup(props, { expose, slots }) {
      expose({ runShortcut: (action: string) => runShortcut(action) })
      // 插槽照样渲染：全屏层的对话按钮、快捷会话圆钮挂在舞台的插槽里
      return () =>
        h("div", { "data-testid": "stage-stub", "data-agent-editing": String(props.agentEditing) }, [
          slots["top-right"]?.(),
          slots["toolbar-end"]?.()
        ])
    }
  })
}))

let runtime: NodeKitRuntime
const selectedNodeIds = ref<string[]>([])
const flowId = ref("flow-1")
const statelessHandlers = new Map<string, Set<(payload: string) => void>>()
const fakeSync = {
  onStateless: (type: string, handler: (payload: string) => void) => {
    const set = statelessHandlers.get(type) ?? new Set()
    set.add(handler)
    statelessHandlers.set(type, set)
    return () => set.delete(handler)
  },
  connected: ref(true)
}

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    flowId,
    nodeKit: runtime,
    store: useFlowStore(),
    sync: fakeSync,
    canvas: { selectedNodeIds }
  })
}))

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>()
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      user: computed(() => ({ id: "me", subject: "me", name: "我", username: null, email: null, avatarUrl: null, roles: [] }))
    })
  }
})

const toastInfo = vi.fn()
vi.mock("vue-sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: (...args: unknown[]) => toastInfo(...args) }
}))

const session = vi.fn<(id: string) => Promise<AgentSessionView>>()
const send = vi.fn()
const conversations = vi.fn<(id: string) => Promise<AgentConversationSummary[]>>()
const conversation = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agentApi: {
    session: (id: string) => session(id),
    send: (...args: unknown[]) => send(...args),
    runEvents: vi.fn(),
    abort: vi.fn(),
    conversations: (id: string) => conversations(id),
    conversation: (...args: unknown[]) => conversation(...args),
    deleteConversation: vi.fn()
  },
  projectApi: { get: (): Promise<ProjectSummary> => new Promise(() => {}) }
}))

vi.mock("vue-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-router")>()),
  onBeforeRouteLeave: vi.fn()
}))

const { default: FlowDirectorOverlay } = await import("@/components/flow/FlowDirectorOverlay.vue")
const { useFlowShortcuts } = await import("@/composables/flow/useFlowShortcuts")

if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList

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

function summary(id: string, patch: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
  return {
    id,
    title: id,
    summary: "",
    messageCount: 1,
    createdAt: 1,
    updatedAt: 1,
    owner: { id: "me", name: "我", avatarUrl: null },
    mine: true,
    running: false,
    nodeId: null,
    skills: [],
    ...patch
  }
}

/** 一个节点作为事件源（只要 id / type / emit） */
function sourceOf(id: string, type: string): NodeEventSource {
  const source = {
    id,
    type,
    emit: (event: never, payload: never) => runtime.kit.emit(event, payload, source as never)
  }
  return source as unknown as NodeEventSource
}

let wrapper: VueWrapper | null = null

/** 画布那一侧：真的 `useFlowShortcuts`（挂在 window 冒泡阶段），动作换成记账的 */
const canvasUndo = vi.fn()
const canvasRedo = vi.fn()
const canvasDelete = vi.fn()

async function mountOverlay() {
  const Host = defineComponent({
    setup() {
      useFlowShortcuts({
        store: { undo: canvasUndo, redo: canvasRedo },
        canvas: { deleteSelection: canvasDelete },
        selection: { selectedNodeId: ref("t1") },
        nodeKit: runtime,
        document: { flushBeforeLeave: async () => {} }
      } as never)
      return () => h(TooltipProvider, null, () => h(FlowDirectorOverlay))
    }
  })
  wrapper = mount(Host, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** 画布快捷键这次有没有动手 */
const canvasActed = () => canvasUndo.mock.calls.length + canvasRedo.mock.calls.length + canvasDelete.mock.calls.length

async function openDirector(prompt?: string) {
  runtime.kit.emit("director:open", prompt ? { prompt } : {}, sourceOf("dc", "director"))
  await flushPromises()
}

const overlay = () => document.querySelector('[data-testid="director-overlay"]')

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}


beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ""
  runtime = createNodeKitRuntime(createDefaultNodeKit())
  const store = useFlowStore()
  store.load(detail())
  store.attachDoc(new Y.Doc())
  store.addNode(buildNodeRecord({ id: "dc", type: "director", label: "开场", position: { x: 0, y: 0 } }))
  store.addNode(buildNodeRecord({ id: "t1", type: "text", label: "文本", position: { x: 0, y: 0 } }))
  runShortcut.mockClear()
  canvasUndo.mockReset()
  canvasRedo.mockReset()
  canvasDelete.mockReset()
  toastInfo.mockReset()
  session.mockReset().mockResolvedValue({ enabled: true, running: false, activeRuns: [], latest: null })
  conversations.mockReset().mockResolvedValue([])
  conversation.mockReset()
  send.mockReset().mockImplementation(async (_id: string, _body: unknown, options: { onOpen?: () => void; onEvent: (e: unknown) => void }) => {
    options.onOpen?.()
    options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
    options.onEvent({
      type: "RUN_FINISHED",
      threadId: "c-new",
      runId: "r1",
      outcome: { type: "success" },
      result: { id: "a1", role: "assistant", text: "好了", toolCalls: [], createdAt: 2 }
    })
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("全屏导演台的键盘", () => {
  it("开着时画布快捷键一律不生效；Delete / Ctrl+Z / 空格交给导演台", async () => {
    await mountOverlay()
    // 关着：按键照常到画布
    press(document.body, { key: "Delete" })
    expect(canvasDelete).toHaveBeenCalledTimes(1)

    await openDirector()
    expect(overlay()).not.toBeNull()
    canvasDelete.mockReset()

    expect(press(document.body, { key: "Delete" }).defaultPrevented).toBe(true)
    press(document.body, { key: "z", ctrlKey: true })
    press(document.body, { key: "z", metaKey: true, shiftKey: true })
    press(document.body, { key: "y", ctrlKey: true })
    press(overlay()!, { key: " " })
    expect(canvasActed()).toBe(0)
    expect(runShortcut.mock.calls.map(([action]) => action)).toEqual(["delete", "undo", "redo", "redo", "toggle-play"])
    // 画布上的节点一个没少
    expect(useFlowStore().nodeById.has("t1")).toBe(true)
  })

  it("对话面板的输入框收得到按键：Shift+回车发送；里面的 Delete / Ctrl+Z 不触发导演台快捷键，也到不了画布", async () => {
    await mountOverlay()
    await openDirector()
    const input = wrapper!.findComponent(PromptInput)
    input.vm.$emit("update:modelValue", "搭一个客厅")
    await flushPromises()
    const editable = document.querySelector('[data-testid="director-overlay"] [data-cy="prompt-input"]') as HTMLElement

    press(editable, { key: "Backspace" })
    press(editable, { key: "z", ctrlKey: true })
    expect(runShortcut).not.toHaveBeenCalled()

    press(editable, { key: "Enter", shiftKey: true })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    // 新会话的第一条带 nodeId：服务端只记下入口（会话是全局 agent）
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(["flow-1", { text: "搭一个客厅", conversationId: null, nodeId: "dc" }])
    expect(canvasActed()).toBe(0)
  })

  it("Esc：输入框里先失焦（不关）；再按一次关闭，画布照常收到按键", async () => {
    await mountOverlay()
    await openDirector()
    const editable = document.querySelector('[data-testid="director-overlay"] [data-cy="prompt-input"]') as HTMLElement
    editable.focus()
    press(editable, { key: "Escape" })
    await flushPromises()
    expect(overlay()).not.toBeNull()

    press(document.body, { key: "Escape" })
    await flushPromises()
    expect(overlay()).toBeNull()
    press(document.body, { key: "Delete" })
    expect(canvasDelete).toHaveBeenCalledTimes(1)
  })

  it("下拉菜单里按 Esc：交给菜单自己关（window 上的监听照常收到），不关导演台", async () => {
    await mountOverlay()
    await openDirector()
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    const item = document.createElement("div")
    menu.append(item)
    overlay()!.append(menu)
    const windowEsc = vi.fn()
    window.addEventListener("keydown", windowEsc)
    press(item, { key: "Escape" })
    window.removeEventListener("keydown", windowEsc)
    await flushPromises()
    expect(windowEsc).toHaveBeenCalledTimes(1)
    expect(overlay()).not.toBeNull()
  })
})

describe("全屏导演台的界面", () => {
  it("左上只有返回画布 + 节点名，点返回关闭；右上对话按钮和底部快捷会话是导演台那一份", async () => {
    await mountOverlay()
    await openDirector()
    expect(document.querySelector('[data-testid="director-title"]')?.textContent).toBe("开场")
    const chatToggle = document.querySelector('[data-testid="director-overlay"] [data-testid="agent-toggle"]')
    expect(chatToggle?.getAttribute("aria-label")).toBe("导演台助手")
    const quick = document.querySelector('[data-testid="director-overlay"] [data-testid="agent-quick-toggle"]')
    expect(quick?.getAttribute("aria-label")).toBe("让助手改这个场景（新会话）")

    ;(document.querySelector('[data-testid="director-close"]') as HTMLElement).click()
    await flushPromises()
    expect(overlay()).toBeNull()
  })
})

describe("对话面板选会话", () => {
  it("默认打开我在这个节点上最近的那个会话（不是别的节点的、不是别人的）", async () => {
    conversations.mockResolvedValue([
      summary("c-other-node", { nodeId: "x", updatedAt: 9 }),
      summary("c-theirs", { nodeId: "dc", updatedAt: 8, mine: false }),
      summary("c-old", { nodeId: "dc", updatedAt: 2 }),
      summary("c-new", { nodeId: "dc", updatedAt: 5 }),
      summary("c-plain", { updatedAt: 10 })
    ])
    conversation.mockImplementation(async (_flow: string, id: string) => ({ ...summary(id, { nodeId: "dc" }), messages: [] }))
    await mountOverlay()
    await openDirector()
    expect(conversation).toHaveBeenCalledWith("flow-1", "c-new")
    expect(document.querySelector('[data-testid="director-overlay"] [data-testid="agent-title"]')?.textContent).toContain("c-new")
  })

  it("有 agent 占用这个节点（occupies）：顶部显示「某某的助手正在编辑这个场景」，舞台据此高亮远端改动；只是入口是它不算", async () => {
    await mountOverlay()
    await openDirector()
    expect(document.querySelector('[data-testid="director-agent-editing"]')).toBeNull()
    const push = (runs: unknown[]) => {
      for (const handler of statelessHandlers.get("agent:runs") ?? []) {
        handler(JSON.stringify({ type: "agent:runs", flowId: "flow-1", runs }))
      }
    }
    const base = { conversationTitle: "t", startedAt: 1 }
    // 从这个导演台发起（入口 nodeId 是它）、但没写它：不算在编辑
    push([{ ...base, runId: "r-a", conversationId: "c-a", owner: { id: "u2", name: "张三", avatarUrl: null }, nodeId: "dc", occupies: ["x"] }])
    await flushPromises()
    expect(document.querySelector('[data-testid="director-agent-editing"]')).toBeNull()
    expect(document.querySelector('[data-testid="stage-stub"]')?.getAttribute("data-agent-editing")).toBe("false")

    // 从画布上发起的另一轮写了它的场景（occupies 含它）：显示是谁
    push([
      { ...base, runId: "r-a", conversationId: "c-a", owner: { id: "u2", name: "张三", avatarUrl: null }, nodeId: "dc", occupies: ["x"] },
      { ...base, runId: "r-b", conversationId: "c-b", owner: { id: "u3", name: "李四", avatarUrl: null }, occupies: ["dc"] }
    ])
    await flushPromises()
    expect(document.querySelector('[data-testid="director-agent-editing"]')?.textContent).toContain("李四的助手正在编辑这个场景")
    expect(document.querySelector('[data-testid="director-agent-editing"]')?.textContent).not.toContain("张三")
    expect(document.querySelector('[data-testid="stage-stub"]')?.getAttribute("data-agent-editing")).toBe("true")
  })
})

const DC = "@{node:dc}"
const chatInput = () =>
  wrapper!
    .findAllComponents(PromptInput)
    .find((item) => item.element.closest('[data-testid="agent-dialog"]'))!
const quickInput = () =>
  wrapper!
    .findAllComponents(PromptInput)
    .find((item) => item.element.closest('[data-testid="agent-quick-prompt"]'))

describe("打开导演台算选中这个导演台节点（docs/20 §3.10.9）", () => {
  it("没有我在这个节点上的会话 → 新会话，对话框输入框开头是这个导演台的提及；空状态不再说「只改这个导演台」", async () => {
    await mountOverlay()
    await openDirector()
    expect(chatInput().props("modelValue")).toBe(`${DC} `)
    const dialog = document.querySelector('[data-testid="director-overlay"] [data-testid="agent-dialog"]')!
    expect(dialog.textContent).not.toContain("只改这个导演台")
  })

  it("默认打开的是已有会话（续聊）→ 输入框为空，不加提及", async () => {
    conversations.mockResolvedValue([summary("c-mine", { nodeId: "dc" })])
    conversation.mockResolvedValue({ ...summary("c-mine", { nodeId: "dc" }), messages: [] })
    await mountOverlay()
    await openDirector()
    expect(chatInput().props("modelValue")).toBe("")
  })

  it("点「新会话」→ 空输入框开头放上提及（可删；已有草稿不动）", async () => {
    conversations.mockResolvedValue([summary("c-mine", { nodeId: "dc" })])
    conversation.mockResolvedValue({ ...summary("c-mine", { nodeId: "dc" }), messages: [] })
    await mountOverlay()
    await openDirector()
    ;(document.querySelector('[data-testid="director-overlay"] [data-testid="agent-new"]') as HTMLElement).click()
    await flushPromises()
    expect(chatInput().props("modelValue")).toBe(`${DC} `)

    // 删掉提及、写点别的，再点一次新会话：草稿不动
    chatInput().vm.$emit("update:modelValue", "只想问问")
    await flushPromises()
    ;(document.querySelector('[data-testid="director-overlay"] [data-testid="agent-new"]') as HTMLElement).click()
    await flushPromises()
    expect(chatInput().props("modelValue")).toBe("只想问问")
  })

  it("快捷会话：打开时输入框开头是这个导演台的提及（只它一个，不看画布选区），发出去带着它和 nodeId", async () => {
    selectedNodeIds.value = ["t1"]
    await mountOverlay()
    await openDirector()
    ;(document.querySelector('[data-testid="director-overlay"] [data-testid="agent-quick-toggle"]') as HTMLElement).click()
    await flushPromises()
    expect(quickInput()!.props("modelValue")).toBe(`${DC} `)
    quickInput()!.vm.$emit("update:modelValue", `${DC} 加一盏灯`)
    await flushPromises()
    ;(document.querySelector('[data-testid="agent-quick-prompt"] [data-testid="agent-send"]') as HTMLElement).click()
    await flushPromises()
    expect(send.mock.lastCall!.slice(0, 2)).toEqual(["flow-1", { text: `${DC} 加一盏灯`, conversationId: null, nodeId: "dc" }])
    selectedNodeIds.value = []
  })
})

describe("节点底部输入框发起的会话", () => {
  it("composer:submit → 打开导演台，在新会话里发出这条消息：开头补上这个节点的提及、带 nodeId；输入框不留提及", async () => {
    await mountOverlay()
    runtime.kit.emit("composer:submit", { text: "  镜头绕一圈  " }, sourceOf("dc", "director"))
    await flushPromises()
    expect(overlay()).not.toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(["flow-1", { text: `${DC} 镜头绕一圈`, conversationId: null, nodeId: "dc" }])
    expect(chatInput().props("modelValue")).toBe("")
  })

  it("消息里已经提及了这个节点 → 不重复补", async () => {
    await mountOverlay()
    runtime.kit.emit("composer:submit", { text: `把 ${DC} 的灯调暗` }, sourceOf("dc", "director"))
    await flushPromises()
    expect(send.mock.calls[0]![1]).toMatchObject({ text: `把 ${DC} 的灯调暗` })
  })

  it("续聊入口是这个节点的会话时不再带 nodeId（服务端从会话里读），提及照样补", async () => {
    conversations.mockResolvedValue([summary("c-bound", { nodeId: "dc" })])
    conversation.mockResolvedValue({ ...summary("c-bound", { nodeId: "dc" }), messages: [] })
    await mountOverlay()
    runtime.kit.emit("composer:submit", { text: "再慢一点" }, sourceOf("dc", "director"))
    await flushPromises()
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(["flow-1", { text: `${DC} 再慢一点`, conversationId: "c-bound" }])
  })

  it("空提示词不打开；别的类型的 composer:submit 不归它管", async () => {
    await mountOverlay()
    runtime.kit.emit("composer:submit", { text: "   " }, sourceOf("dc", "director"))
    runtime.kit.emit("composer:submit", { text: "画一只猫" }, sourceOf("t1", "text"))
    await flushPromises()
    expect(overlay()).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
