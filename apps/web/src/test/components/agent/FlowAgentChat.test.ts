import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { computed, defineComponent, h, ref } from "vue"
import {
  formatAgentRunsMessage,
  type AgentActiveRunView,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentRunEntry,
  type AgentSessionView,
  type AgentStreamEvent
} from "@shadecn/shared/agent"
import type { FlowMode, FlowSummary, ProjectSummary } from "@shadecn/shared/canvas"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import PromptInput from "@/components/prompt-input/PromptInput.vue"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * 画布 Agent 对话框。真的挂组件（shadcn-vue / PromptInput 都是真的），只把接口和编辑器上下文打桩：
 * 「点了发送、没反应」「409 了输入框里的字没了」这类问题只在组件层看得见。
 */

const flowId = ref("f1")
const nodes = ref<FlowNode[]>([])
const selectedNodeIds = ref<string[]>([])

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    flowId,
    canvas: { selectedNodeIds },
    store: {
      get nodes() {
        return nodes.value
      },
      get nodeById() {
        return new Map(nodes.value.map((item) => [item.id, item]))
      }
    }
  })
}))

/** 当前登录用户（null = 没开登录：自己的 id 从服务端给的 `mine` 里学） */
const authUser = ref<{ id: string; name: string; avatarUrl: string | null } | null>({
  id: "me",
  name: "我",
  avatarUrl: null
})
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>()
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      user: computed(() =>
        authUser.value ? { ...authUser.value, subject: authUser.value.id, username: null, email: null, roles: [] } : null
      )
    })
  }
})

const toastError = vi.fn()
vi.mock("vue-sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), warning: vi.fn() }
}))

const session = vi.fn<(id: string) => Promise<AgentSessionView>>()
const send = vi.fn()
const runEvents = vi.fn()
const abort = vi.fn<(id: string, runId: string) => Promise<void>>()
const conversations = vi.fn<(id: string) => Promise<AgentConversationSummary[]>>()
const conversation = vi.fn<(id: string, cid: string) => Promise<AgentConversationView>>()
const deleteConversation = vi.fn<(id: string, cid: string) => Promise<void>>()
const projectGet = vi.fn<(id: string) => Promise<ProjectSummary>>()

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agentApi: {
    session: (id: string) => session(id),
    send: (...args: unknown[]) => send(...args),
    runEvents: (...args: unknown[]) => runEvents(...args),
    abort: (id: string, runId: string) => abort(id, runId),
    conversations: (id: string) => conversations(id),
    conversation: (id: string, cid: string) => conversation(id, cid),
    deleteConversation: (id: string, cid: string) => deleteConversation(id, cid)
  },
  projectApi: { get: (id: string) => projectGet(id) }
}))

const { ApiError } = await import("@/lib/api")
const { formatDateTime } = await import("@/lib/format")
const { default: FlowAgentChat } = await import("@/components/flow/agent/FlowAgentChat.vue")
const { provideFlowAgentPanel } = await import("@/composables/flow/agent-panel")

/** 画布是什么：项目画布才标发起人 */
const mode = ref<FlowMode>("collab")
const myRole = ref<"admin" | "member">("member")

/**
 * 同步层的假替身：记下 stateless 订阅，`pushRuns` 模拟服务端经协同连接推一份全量任务列表；
 * `connected` 从断到通 = 重连。
 */
const statelessHandlers = new Map<string, Set<(payload: string) => void>>()
const connected = ref(false)
const fakeSync = {
  onStateless: (type: string, handler: (payload: string) => void) => {
    const set = statelessHandlers.get(type) ?? new Set()
    set.add(handler)
    statelessHandlers.set(type, set)
    return () => set.delete(handler)
  },
  connected
}
function pushPayload(payload: string) {
  for (const handler of statelessHandlers.get("agent:runs") ?? []) handler(payload)
}
async function pushRuns(runs: AgentRunEntry[], targetFlow = flowId.value) {
  pushPayload(formatAgentRunsMessage(targetFlow, runs))
  await flushPromises()
}

const fakeStore = {
  get meta(): FlowSummary {
    return { id: flowId.value, projectId: "p1", mode: mode.value } as FlowSummary
  }
}
const host = { flowId, store: fakeStore, sync: fakeSync }

/** 对话框的 agent 实例由编辑器根视图 provide（和工具栏快捷输入共用），这里垫一层同样的根 */
const Host = defineComponent({
  setup() {
    provideFlowAgentPanel(host)
    return () => h(TooltipProvider, null, () => h(FlowAgentChat))
  }
})
const { default: FlowAgentQuickPrompt } = await import("@/components/flow/agent/FlowAgentQuickPrompt.vue")

/** 编辑器里两个入口同时在：右上角对话框 + 底部工具栏的快捷输入 */
const HostWithQuick = defineComponent({
  setup() {
    provideFlowAgentPanel(host)
    return () => h(TooltipProvider, null, () => [h(FlowAgentChat), h(FlowAgentQuickPrompt)])
  }
})
/**
 * `activeRun` 是单个在跑任务的简写（大多数用例只需要一轮），`activeRuns` 给多轮。
 */
function sessionView(
  overrides: Partial<AgentSessionView> & { activeRun?: AgentActiveRunView | null } = {}
): AgentSessionView {
  const { activeRun: run = null, ...rest } = overrides
  const view: AgentSessionView = {
    enabled: true,
    running: false,
    activeRuns: run ? [run] : [],
    latest: null,
    ...rest
  }
  return { ...view, running: view.activeRuns.length > 0 }
}

function activeRun(overrides: Partial<AgentActiveRunView> = {}): AgentActiveRunView {
  return {
    runId: "r1",
    conversationId: "c1",
    conversationTitle: "会话 c1",
    owner: { id: "me", name: "我", avatarUrl: null },
    mine: true,
    startedAt: 1,
    ...overrides
  }
}

function summary(id: string, overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    summary: "",
    messageCount: 2,
    createdAt: Date.UTC(2026, 0, 2, 3, 4),
    updatedAt: Date.UTC(2026, 0, 2, 3, 4),
    owner: { id: "me", name: "我", avatarUrl: null },
    mine: true,
    running: false,
    nodeId: null,
    skills: [],
    ...overrides
  }
}

function view(id: string, overrides: Partial<AgentConversationView> = {}): AgentConversationView {
  return {
    ...summary(id),
    messages: [
      { id: `${id}-u`, role: "user", text: `问题 ${id}`, createdAt: 1 },
      { id: `${id}-a`, role: "assistant", text: `回答 ${id}`, toolCalls: [], createdAt: 2 }
    ],
    ...overrides
  }
}

function node(id: string, label: string): FlowNode {
  return {
    id,
    type: "text",
    layout: { position: { x: 0, y: 0 } },
    metadata: { label },
    data: { text: "" },
    runtime: { status: "idle" },
    inputs: []
  }
}

type SendOptions = { onEvent: (event: AgentStreamEvent) => void; onOpen?: () => void }
type StreamOptions = { onEvent: (event: AgentStreamEvent) => void; signal?: AbortSignal }

/**
 * 一条可以从测试里一帧一帧推的接回流：`emit` 推事件，`end` 关流；
 * 本地掐掉（`signal`）时像真的 fetch 一样以 AbortError reject。
 */
function controllableStream() {
  let options!: StreamOptions
  let close!: () => void
  let fail!: (error: unknown) => void
  const opened = vi.fn()
  runEvents.mockImplementation((_id: string, _runId: string, given: StreamOptions) => {
    options = given
    opened()
    return new Promise<void>((resolve, reject) => {
      close = resolve
      fail = reject
      given.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  })
  return {
    opened,
    emit: (event: AgentStreamEvent) => options.onEvent(event),
    end: () => close(),
    fail: (error: unknown) => fail(error),
    get signal() {
      return options.signal
    }
  }
}

function lastAssistant(list: { findAll: (selector: string) => { text: () => string }[] }) {
  const items = list.findAll('[data-role="assistant"]')
  return items[items.length - 1]!
}

/** 这一轮的用户消息已经落库（`latest.messages` 的最后一条），assistant 那条还没有 */
function runningConversation(): AgentConversationView {
  return view("c1", {
    running: true,
    messages: [
      { id: "c1-u", role: "user", text: "问题 c1", createdAt: 1 },
      { id: "c1-a", role: "assistant", text: "回答 c1", toolCalls: [], createdAt: 2 },
      { id: "u-run", role: "user", text: "再改一次", createdAt: 3 }
    ]
  })
}

const finished: AgentStreamEvent = {
  type: "RUN_FINISHED",
  threadId: "c1",
  runId: "r1",
  outcome: { type: "success" },
  result: { id: "a-run", role: "assistant", text: "改好了", toolCalls: [], createdAt: 4 }
}

async function mountOpened() {
  const wrapper = mount(Host, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-testid="agent-toggle"]').trigger("click")
  await flushPromises()
  return wrapper
}

async function type(wrapper: Awaited<ReturnType<typeof mountOpened>>, text: string) {
  wrapper.findComponent(PromptInput).vm.$emit("update:modelValue", text)
  await flushPromises()
}

// jsdom 的 Range 没有几何信息；PromptInput 聚焦后要拿光标位置来滚动 / 定位弹出层
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  document.body.innerHTML = ""
  flowId.value = "f1"
  nodes.value = [node("n1", "开场白")]
  selectedNodeIds.value = []
  session.mockReset().mockResolvedValue(sessionView())
  send.mockReset()
  runEvents.mockReset()
  abort.mockReset().mockResolvedValue(undefined)
  conversations.mockReset().mockResolvedValue([])
  conversation.mockReset()
  deleteConversation.mockReset().mockResolvedValue(undefined)
  projectGet.mockReset().mockImplementation(async () => ({ myRole: myRole.value }) as ProjectSummary)
  toastError.mockReset()
  authUser.value = { id: "me", name: "我", avatarUrl: null }
  mode.value = "collab"
  myRole.value = "member"
  connected.value = false
})

describe("画布 Agent 对话框", () => {
  it("打开画布时拿一次历史；没有消息时给空状态说明", async () => {
    const wrapper = await mountOpened()

    expect(session).toHaveBeenCalledWith("f1")
    expect(wrapper.get('[data-testid="agent-empty"]').text()).toContain("@")
    // 头部只有会话标题，不展示用的是哪个模型（接口里也已经没有这个字段）
    expect(wrapper.get("header").text()).toBe("新会话")
  })

  it("服务端没配模型 → 只有说明，没有输入框", async () => {
    session.mockResolvedValue(sessionView({ enabled: false }))
    const wrapper = await mountOpened()

    expect(wrapper.find('[data-testid="agent-disabled"]').exists()).toBe(true)
    expect(wrapper.findComponent(PromptInput).exists()).toBe(false)
  })

  it("发送一轮：流式文字 → 工具条目 → 收尾；运行中按钮换成停止", async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
      options.onEvent({
        type: "CUSTOM",
        name: "agent.user-message",
        value: { id: "u1", role: "user", text: "把 @{node:n1} 改短", createdAt: 1 }
      })
      options.onEvent({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" })
      options.onEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "好的，我来改" })
      await gate
      options.onEvent({
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "update_node_text",
        parentMessageId: "a1",
        metadata: { summary: "改写节点 开场白", status: "running" }
      })
      options.onEvent({
        type: "TOOL_CALL_RESULT",
        messageId: "tm1",
        toolCallId: "t1",
        content: "ok",
        role: "tool",
        metadata: { summary: "改写节点 开场白", status: "done" }
      })
      options.onEvent({
        type: "RUN_FINISHED",
        threadId: "c-new",
        runId: "r1",
        outcome: { type: "success" },
        result: {
          id: "a1",
          role: "assistant",
          text: "好的，我来改。改完了。",
          toolCalls: [{ id: "t1", name: "update_node_text", summary: "改写节点 开场白", status: "done" }],
          createdAt: 2
        }
      })
    })

    const wrapper = await mountOpened()
    await type(wrapper, "把 @{node:n1} 改短")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(send).toHaveBeenCalledWith("f1", { text: "把 @{node:n1} 改短", conversationId: null }, expect.anything())
    const list = wrapper.get('[data-testid="agent-messages"]')
    // 用户消息里的提及渲染成 badge，显示节点当前的名字
    expect(list.get('[data-role="user"] [data-mention-id="n1"]').text()).toBe("开场白")
    expect(list.get('[data-role="assistant"]').text()).toContain("好的，我来改")
    // 运行中：发送换成停止，按钮上挂着任务数（不等推送，本窗口发起的先记上），输入框已经清空
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("1")
    expect(wrapper.findComponent(PromptInput).props("modelValue")).toBe("")

    finish()
    await flushPromises()

    expect(list.get('[data-tool-status="done"]').text()).toContain("改写节点 开场白")
    expect(list.get('[data-role="assistant"]').text()).toContain("改完了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
  })

  it("运行中点停止 → 调 abort", async () => {
    send.mockImplementation(
      (_id: string, _body: unknown, options: SendOptions) =>
        new Promise<void>(() => {
          options.onOpen?.()
          options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
        })
    )
    const wrapper = await mountOpened()
    await type(wrapper, "随便改改")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    await wrapper.get('[data-testid="agent-stop"]').trigger("click")
    await flushPromises()
    expect(abort).toHaveBeenCalledWith("f1", "r1")
  })

  it("409 → toast 说明这个会话在跑；用户那条撤回，输入框里的字还回来", async () => {
    send.mockRejectedValue(new ApiError("busy", 409, null))
    const wrapper = await mountOpened()
    await type(wrapper, "加一个节点")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith("这个会话已经有一轮 agent 正在运行，等它结束或先停止它")
    expect(wrapper.find('[data-role="user"]').exists()).toBe(false)
    expect(wrapper.findComponent(PromptInput).props("modelValue")).toBe("加一个节点")
  })

  it("Enter 发送、Shift+Enter 不发送", async () => {
    send.mockResolvedValue(undefined)
    const wrapper = await mountOpened()
    await type(wrapper, "加一个节点")
    const editable = wrapper.get('[data-cy="prompt-input"]')

    await editable.trigger("keydown", { key: "Enter", shiftKey: true })
    await flushPromises()
    expect(send).not.toHaveBeenCalled()

    await editable.trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("面板里的按键不冒到 window —— 画布的 Delete / Ctrl+Z 不会被触发", async () => {
    const wrapper = await mountOpened()
    const seen = vi.fn()
    window.addEventListener("keydown", seen)
    await wrapper.get('[data-testid="agent-dialog"] button').trigger("keydown", { key: "Backspace" })
    window.removeEventListener("keydown", seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it("画布上选中了节点 → 一键引用为提及", async () => {
    nodes.value = [node("n1", "开场白"), node("n2", "结尾")]
    selectedNodeIds.value = ["n1", "n2"]
    const wrapper = await mountOpened()

    const quote = wrapper.get('[data-testid="agent-quote-selection"]')
    expect(quote.text()).toContain("2 个节点")
    await quote.trigger("click")
    await flushPromises()

    expect(wrapper.findComponent(PromptInput).props("modelValue")).toBe("@{node:n1} @{node:n2} ")
    // 都引用过了，按钮收起来
    expect(wrapper.find('[data-testid="agent-quote-selection"]').exists()).toBe(false)
  })

  it("换画布 → 重新拿那张画布的历史", async () => {
    await mountOpened()
    flowId.value = "f2"
    await flushPromises()
    expect(session).toHaveBeenLastCalledWith("f2")
  })

  it("latest 为 null → 新会话空状态，标题是「新会话」", async () => {
    const wrapper = await mountOpened()
    expect(wrapper.find('[data-testid="agent-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-title"]').text()).toBe("新会话")
  })

  it("画布改动通知：历史里的显示成灰色的一行系统提示，有条目时可展开；实时流里的同样追加", async () => {
    session.mockResolvedValue(
      sessionView({
        latest: view("c1", {
          messages: [
            { id: "c1-u", role: "user", text: "问题 c1", createdAt: 1 },
            {
              id: "c1-chg",
              role: "canvas-change",
              scope: "since-last-run",
              summary: "自你上次运行以来画布有 2 处变化",
              items: ["删除节点 text「旧」（n9）", "移动了 1 个节点"],
              actors: [],
              omitted: 0,
              createdAt: 2
            },
            { id: "c1-a", role: "assistant", text: "回答 c1", toolCalls: [], createdAt: 3 }
          ]
        })
      })
    )
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c1", runId: "r2" })
      options.onEvent({ type: "CUSTOM", name: "agent.user-message", value: { id: "u2", role: "user", text: "继续", createdAt: 4 } })
      options.onEvent({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" })
      options.onEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "好" })
      options.onEvent({
        type: "CUSTOM",
        name: "agent.canvas-change",
        value: {
          id: "chg-live",
          role: "canvas-change",
          scope: "live",
          summary: "爱丽丝 改动了画布（1 处）",
          items: [],
          actors: ["爱丽丝"],
          omitted: 0,
          createdAt: 5
        }
      })
      options.onEvent({
        type: "RUN_FINISHED",
        threadId: "c1",
        runId: "r2",
        outcome: { type: "success" },
        result: { id: "a2", role: "assistant", text: "好", toolCalls: [], createdAt: 4 }
      })
    })

    const wrapper = await mountOpened()
    const list = wrapper.get('[data-testid="agent-messages"]')
    const fromHistory = list.get('[data-role="canvas-change"][data-scope="since-last-run"]')
    expect(fromHistory.get('[data-role="canvas-change-summary"]').text()).toBe("自你上次运行以来画布有 2 处变化")
    // 默认折叠，条目在 <details> 里
    expect(fromHistory.get("details").attributes("open")).toBeUndefined()
    expect(fromHistory.findAll('[data-role="canvas-change-items"] li').map((item) => item.text())).toEqual([
      "删除节点 text「旧」（n9）",
      "移动了 1 个节点"
    ])
    // 不是气泡：不算 user / assistant
    expect(list.findAll('[data-role="assistant"]')).toHaveLength(1)

    await type(wrapper, "继续")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    const lines = list.findAll('[data-role="canvas-change"]')
    expect(lines).toHaveLength(2)
    const live = lines[1]!
    expect(live.attributes("data-scope")).toBe("live")
    // 没有条目：只有一行概括，不能展开
    expect(live.find("details").exists()).toBe(false)
    expect(live.text()).toBe("爱丽丝 改动了画布（1 处）")
    // 顺序：…assistant(好) → 通知
    const roles = list.findAll("[data-role]").map((item) => item.attributes("data-role"))
    expect(roles.filter((role) => role === "user" || role === "assistant" || role === "canvas-change")).toEqual([
      "user",
      "canvas-change",
      "assistant",
      "user",
      "assistant",
      "canvas-change"
    ])
  })

  it("技能：输入框上方列出会话已加载的技能、标题里不显示；实时流里加载一次，对话里多一行「已加载：…」、那一栏跟着多一个", async () => {
    session.mockResolvedValue(
      sessionView({
        latest: view("c1", {
          skills: [
            { id: "canvas", title: "画布（只读）" },
            { id: "canvas-edit", title: "画布编辑" }
          ]
        })
      })
    )
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c1", runId: "r2" })
      options.onEvent({ type: "CUSTOM", name: "agent.user-message", value: { id: "u2", role: "user", text: "看图", createdAt: 4 } })
      options.onEvent({
        type: "CUSTOM",
        name: "agent.skill-loaded",
        value: { id: "skl1", role: "skill-loaded", skill: { id: "media-view", title: "查看素材" }, createdAt: 5 }
      })
      options.onEvent({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" })
      options.onEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "看过了" })
      options.onEvent({
        type: "RUN_FINISHED",
        threadId: "c1",
        runId: "r2",
        outcome: { type: "success" },
        result: { id: "a2", role: "assistant", text: "看过了", toolCalls: [], createdAt: 4 }
      })
    })

    const wrapper = await mountOpened()
    const badges = () => wrapper.findAll('[data-testid="agent-skills"] [data-skill]').map((item) => item.text())
    expect(badges()).toEqual(["画布（只读）", "画布编辑"])
    expect(wrapper.find('[data-testid="agent-title"] [data-skill]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="agent-title"]').text()).not.toContain("画布编辑")

    await type(wrapper, "看图")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    const line = wrapper.get('[data-testid="agent-messages"] [data-role="skill-loaded"]')
    expect(line.text()).toBe("已加载：查看素材")
    expect(line.attributes("data-skill")).toBe("media-view")
    expect(badges()).toEqual(["画布（只读）", "画布编辑", "查看素材"])
  })

  it("有 latest → 默认显示它的消息和标题（含提及）", async () => {
    session.mockResolvedValue(
      sessionView({ latest: view("c1", { title: "改 @{node:n1}" }) })
    )
    const wrapper = await mountOpened()
    expect(wrapper.text()).toContain("回答 c1")
    expect(wrapper.get('[data-testid="agent-title"] [data-mention-id="n1"]').text()).toBe("开场白")
  })

  it("新会话按钮：清空当前会话、不发请求；之后发送 conversationId 为 null，RUN_STARTED 后续聊带上 threadId", async () => {
    session.mockResolvedValue(sessionView({ latest: view("c1") }))
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
      options.onEvent({
        type: "RUN_FINISHED",
        threadId: "c-new",
        runId: "r1",
        outcome: { type: "success" },
        result: { id: `a-${send.mock.calls.length}`, role: "assistant", text: "好", toolCalls: [], createdAt: 2 }
      })
    })
    const wrapper = await mountOpened()
    expect(wrapper.text()).toContain("回答 c1")

    await wrapper.get('[data-testid="agent-new"]').trigger("click")
    await flushPromises()
    expect(wrapper.find('[data-role="assistant"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-empty"]').exists()).toBe(true)
    expect(conversation).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    await type(wrapper, "第一条")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith("f1", { text: "第一条", conversationId: null }, expect.anything())

    await type(wrapper, "第二条")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith("f1", { text: "第二条", conversationId: "c-new" }, expect.anything())
  })

  it("当前会话在跑也能新建 / 切走：只断本地的读、不调 abort；那一轮留在任务列表里，切回来接上", async () => {
    session.mockResolvedValue(sessionView({ latest: view("c1") }))
    conversations.mockResolvedValue([summary("c1"), summary("c2")])
    let sendSignal: AbortSignal | undefined
    send.mockImplementation(
      (_id: string, _body: unknown, options: SendOptions & { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          sendSignal = options.signal
          options.onOpen?.()
          options.onEvent({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
          options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )
    const wrapper = await mountOpened()
    await type(wrapper, "跑着")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    // 新会话按钮不再禁用；历史列表里别的会话也能点
    expect(wrapper.get('[data-testid="agent-new"]').attributes("disabled")).toBeUndefined()
    await wrapper.get('[data-testid="agent-history-toggle"]').trigger("click")
    await flushPromises()
    expect(wrapper.get('[data-conversation-id="c2"] [data-role="select"]').attributes("disabled")).toBeUndefined()

    conversation.mockResolvedValueOnce(view("c2"))
    await wrapper.get('[data-conversation-id="c2"] [data-role="select"]').trigger("click")
    await flushPromises()
    expect(sendSignal?.aborted).toBe(true)
    expect(abort).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("回答 c2")
    // c2 不在跑：能发；c1 那一轮还在角标里
    expect(wrapper.find('[data-testid="agent-send"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("1")

    // 从任务列表切回 c1：订阅它的事件流，补发把这一轮拼出来
    const stream = controllableStream()
    conversation.mockResolvedValueOnce(runningConversation())
    await wrapper.get('[data-testid="agent-tasks-toggle"]').trigger("click")
    await flushPromises()
    await wrapper.get('[data-run-id="r1"] [data-role="select"]').trigger("click")
    await flushPromises()
    expect(runEvents).toHaveBeenCalledWith("f1", "r1", expect.anything())
    stream.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    stream.emit(finished)
    stream.end()
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("改好了")
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
  })

  describe("历史会话", () => {
    async function openHistory(wrapper: Awaited<ReturnType<typeof mountOpened>>) {
      await wrapper.get('[data-testid="agent-history-toggle"]').trigger("click")
      await flushPromises()
    }

    it("每次打开都拉一次列表；渲染标题(含提及)/摘要/时间/消息数/运行中，当前会话高亮", async () => {
      session.mockResolvedValue(sessionView({ latest: view("c1") }))
      conversations.mockResolvedValue([
        summary("c1", { title: "改 @{node:n1} 的文案", summary: "已经改好了", messageCount: 4 }),
        summary("c2", { running: true })
      ])
      const wrapper = await mountOpened()
      await openHistory(wrapper)

      expect(conversations).toHaveBeenCalledWith("f1")
      const row = wrapper.get('[data-conversation-id="c1"]')
      expect(row.get('[data-role="title"] [data-mention-id="n1"]').text()).toBe("开场白")
      expect(row.get('[data-role="summary"]').text()).toBe("已经改好了")
      expect(row.get('[data-role="count"]').text()).toContain("4")
      expect(row.get('[data-role="time"]').text()).toBe(formatDateTime(Date.UTC(2026, 0, 2, 3, 4)))
      expect(row.attributes("data-current")).toBe("true")
      expect(wrapper.get('[data-conversation-id="c2"]').attributes("data-current")).toBeUndefined()
      expect(wrapper.get('[data-conversation-id="c2"] [data-role="running"]').text()).toContain("运行中")

      // 返回再打开：重新拉
      await wrapper.get('[data-testid="agent-history-back"]').trigger("click")
      await openHistory(wrapper)
      expect(conversations).toHaveBeenCalledTimes(2)
    })

    it("加载中 / 空列表 / 失败各有状态；失败可重试", async () => {
      let resolve!: (v: AgentConversationSummary[]) => void
      conversations.mockReturnValueOnce(new Promise((r) => (resolve = r)))
      const wrapper = await mountOpened()
      await openHistory(wrapper)
      expect(wrapper.find('[data-testid="agent-history-loading"]').exists()).toBe(true)
      resolve([])
      await flushPromises()
      expect(wrapper.find('[data-testid="agent-history-empty"]').exists()).toBe(true)

      await wrapper.get('[data-testid="agent-history-back"]').trigger("click")
      conversations.mockRejectedValueOnce(new Error("网络错误"))
      await openHistory(wrapper)
      expect(wrapper.get('[data-testid="agent-history-error"]').text()).toContain("网络错误")

      conversations.mockResolvedValueOnce([summary("c1")])
      await wrapper.get('[data-testid="agent-history-error"] button').trigger("click")
      await flushPromises()
      expect(wrapper.find('[data-conversation-id="c1"]').exists()).toBe(true)
    })

    it("点选一个会话 → 回到对话视图并加载该会话", async () => {
      conversations.mockResolvedValue([summary("c1"), summary("c2")])
      conversation.mockResolvedValue(view("c2"))
      const wrapper = await mountOpened()
      await openHistory(wrapper)

      await wrapper.get('[data-conversation-id="c2"] [data-role="select"]').trigger("click")
      await flushPromises()

      expect(conversation).toHaveBeenCalledWith("f1", "c2")
      expect(wrapper.find('[data-testid="agent-history"]').exists()).toBe(false)
      expect(wrapper.text()).toContain("回答 c2")
    })

    it("返回按钮回到原来的会话，不重新加载", async () => {
      session.mockResolvedValue(sessionView({ latest: view("c1") }))
      conversations.mockResolvedValue([summary("c1")])
      const wrapper = await mountOpened()
      await openHistory(wrapper)
      await wrapper.get('[data-testid="agent-history-back"]').trigger("click")
      await flushPromises()
      expect(wrapper.text()).toContain("回答 c1")
      expect(conversation).not.toHaveBeenCalled()
    })

    it("删除：确认后才调用 DELETE，行消失", async () => {
      conversations.mockResolvedValue([summary("c1"), summary("c2")])
      const wrapper = await mountOpened()
      await openHistory(wrapper)

      await wrapper.get('[data-conversation-id="c2"] [data-role="delete"]').trigger("click")
      await flushPromises()
      expect(deleteConversation).not.toHaveBeenCalled()

      const confirm = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "删除"
      )!
      confirm.click()
      await flushPromises()

      expect(deleteConversation).toHaveBeenCalledWith("f1", "c2")
      expect(wrapper.find('[data-conversation-id="c2"]').exists()).toBe(false)
      expect(wrapper.find('[data-conversation-id="c1"]').exists()).toBe(true)
    })

    it("删除当前会话 → 回到新会话空状态", async () => {
      session.mockResolvedValue(sessionView({ latest: view("c1") }))
      conversations.mockResolvedValue([summary("c1")])
      const wrapper = await mountOpened()
      await openHistory(wrapper)

      await wrapper.get('[data-conversation-id="c1"] [data-role="delete"]').trigger("click")
      await flushPromises()
      Array.from(document.body.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "删除")!
        .click()
      await flushPromises()

      expect(deleteConversation).toHaveBeenCalledWith("f1", "c1")
      expect(wrapper.find('[data-testid="agent-history"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="agent-empty"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="agent-title"]').text()).toBe("新会话")
    })

    it("服务端标记运行中的会话 → 删除按钮禁用", async () => {
      conversations.mockResolvedValue([summary("c1", { running: true })])
      const wrapper = await mountOpened()
      await openHistory(wrapper)
      expect(wrapper.get('[data-conversation-id="c1"] [data-role="delete"]').attributes("disabled")).toBeDefined()
    })

    it("删除 409 → toast 提示，会话还在", async () => {
      conversations.mockResolvedValue([summary("c1")])
      deleteConversation.mockRejectedValue(new ApiError("busy", 409, null))
      const wrapper = await mountOpened()
      await openHistory(wrapper)
      await wrapper.get('[data-conversation-id="c1"] [data-role="delete"]').trigger("click")
      await flushPromises()
      Array.from(document.body.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "删除")!
        .click()
      await flushPromises()
      expect(toastError).toHaveBeenCalledWith("这个会话正在运行，等它结束再删除")
      expect(wrapper.find('[data-conversation-id="c1"]').exists()).toBe(true)
    })
  })
})

/**
 * 一轮不随 HTTP 连接存亡（关面板、换画布、刷新都不停它），所以打开画布时要能接回去。
 * 这里守的都是「坏了也不报错、只是看着不对」的那类：用户消息出现两遍、接回之后按钮一直转、
 * 别人的一轮结束了这边还锁着、换了画布旧流还在往新对话里写。
 */
describe("接回进行中的一轮", () => {
  it("打开时有我自己在跑的一轮 → 打开那个会话、自动订阅；补发的用户消息不重复，收尾后复位", async () => {
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const stream = controllableStream()
    const wrapper = await mountOpened()

    expect(runEvents).toHaveBeenCalledWith("f1", "r1", expect.anything())
    // 运行中：停止按钮可用，按钮上挂着任务数
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("1")

    // 补发：从 RUN_STARTED 起，和发起时那条流一模一样
    stream.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    stream.emit({
      type: "CUSTOM",
      name: "agent.user-message",
      value: { id: "u-run", role: "user", text: "再改一次", createdAt: 3 }
    })
    stream.emit({ type: "TEXT_MESSAGE_START", messageId: "a-run", role: "assistant" })
    stream.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "a-run", delta: "正在改" })
    await flushPromises()

    const list = wrapper.get('[data-testid="agent-messages"]')
    expect(list.findAll('[data-role="user"]').map((item) => item.text())).toEqual(["问题 c1", "再改一次"])
    expect(lastAssistant(list).text()).toContain("正在改")

    stream.emit(finished)
    stream.end()
    await flushPromises()

    expect(lastAssistant(list).text()).toContain("改好了")
    expect(list.findAll('[data-role="user"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-send"]').exists()).toBe(true)
  })

  it("快照里的任务项没有会话 id（契约上不会出现）→ 当它不存在，不拿 latest 去接", async () => {
    session.mockResolvedValue(
      sessionView({ activeRun: activeRun({ conversationId: "" }), latest: view("c0") })
    )
    const wrapper = await mountOpened()

    expect(runEvents).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
    expect(wrapper.text()).toContain("回答 c0")
  })

  it("补发的 RUN_STARTED 说这一轮属于另一个会话 → 不折叠进当前会话，掐掉流，不报错也不空转重连", async () => {
    session.mockResolvedValue(sessionView({ activeRun: activeRun({ conversationId: "c0" }), latest: view("c0") }))
    const first = controllableStream()
    const wrapper = await mountOpened()

    first.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    first.emit({ type: "TEXT_MESSAGE_START", messageId: "a-run", role: "assistant" })
    first.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "a-run", delta: "不该出现在 c0 里" })
    await flushPromises()
    expect(first.signal!.aborted).toBe(true)
    expect(wrapper.text()).not.toContain("不该出现在 c0 里")

    // 同一份任务列表再推一次：这一轮已经记成「接不回来」，不再订阅
    await pushRuns([activeRun({ conversationId: "c0" })])
    expect(runEvents).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("接回的流以 RUN_ERROR 收尾（run_failed）→ 把原因摆出来，状态复位", async () => {
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const stream = controllableStream()
    const wrapper = await mountOpened()

    stream.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    stream.emit({ type: "RUN_ERROR", message: "模型调用失败", code: "run_failed" })
    stream.end()
    await flushPromises()

    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("模型调用失败")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(session).toHaveBeenCalledTimes(1)
  })

  it("接回的一轮点停止 → 调 abort", async () => {
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    controllableStream()
    const wrapper = await mountOpened()

    await wrapper.get('[data-testid="agent-stop"]').trigger("click")
    await flushPromises()
    expect(abort).toHaveBeenCalledWith("f1", "r1")
  })

  it("接回时 404（已经结束了）→ 不报错，改为重新拉会话", async () => {
    session
      .mockResolvedValueOnce(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
      .mockResolvedValueOnce(
        sessionView({
          latest: view("c1", {
            messages: [
              ...runningConversation().messages,
              { id: "a-run", role: "assistant", text: "早就改好了", toolCalls: [], createdAt: 4 }
            ]
          })
        })
      )
    runEvents.mockRejectedValue(new ApiError("not found", 404, null))
    const wrapper = await mountOpened()

    expect(session).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("早就改好了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("接回时 410（补发缓冲溢出）→ 不报错、不轮询；等推送说那一轮结束了再拉会话", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    runEvents.mockRejectedValue(new ApiError("gone", 410, null))
    const wrapper = await mountOpened()

    // 还在跑：停止按钮照样在（服务端那一轮是真的在跑），只是看不到过程
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    // 没有轮询：等多久都不会再问服务端
    await vi.advanceTimersByTimeAsync(60_000)
    expect(session).toHaveBeenCalledTimes(1)

    // 还在跑的推送：同一轮不再去订阅（否则「接回 → 410 → 接回」空转）
    await pushRuns([activeRun()])
    expect(runEvents).toHaveBeenCalledTimes(1)

    conversation.mockResolvedValue(
      view("c1", {
        messages: [
          ...runningConversation().messages,
          { id: "a-run", role: "assistant", text: "终于改好了", toolCalls: [], createdAt: 4 }
        ]
      })
    )
    await pushRuns([])

    expect(conversation).toHaveBeenCalledWith("f1", "c1")
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("终于改好了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
    expect(session).toHaveBeenCalledTimes(1)
  })

  it("别人在别的会话里跑 → 角标计数，但不挡我在自己的会话里发送", async () => {
    session.mockResolvedValue(
      sessionView({
        activeRun: activeRun({ runId: "r9", conversationId: "c9", mine: false, owner: { id: "u2", name: "乙", avatarUrl: null } }),
        latest: view("c1")
      })
    )
    send.mockResolvedValue(undefined)
    const wrapper = await mountOpened()

    expect(runEvents).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("1")
    // 我自己的会话照常显示、照常能发，没有可停的
    expect(wrapper.text()).toContain("回答 c1")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    await type(wrapper, "加一个节点")
    expect(wrapper.get('[data-testid="agent-send"]').attributes("disabled")).toBeUndefined()
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()
    expect(send).toHaveBeenCalledWith("f1", { text: "加一个节点", conversationId: "c1" }, expect.anything())
  })

  it("换画布 → 断开接回的那条流，旧画布的事件不再写进对话", async () => {
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const stream = controllableStream()
    const wrapper = await mountOpened()
    const signal = stream.signal!

    session.mockResolvedValue(sessionView())
    flowId.value = "f2"
    await flushPromises()

    expect(signal.aborted).toBe(true)
    // 只掐本地的读，不替用户中止服务端那一轮
    expect(abort).not.toHaveBeenCalled()
    expect(session).toHaveBeenLastCalledWith("f2")
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
  })

  it("自己发起的一轮跑着时卸载组件 → 只断本地的读，不调 abort", async () => {
    let signal: AbortSignal | undefined
    send.mockImplementation(
      (_id: string, _body: unknown, options: SendOptions & { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal = options.signal
          options.onOpen?.()
          options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
          options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )
    const wrapper = await mountOpened()
    await type(wrapper, "跑着")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    wrapper.unmount()
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    expect(abort).not.toHaveBeenCalled()
  })

  it("自己发起的那条流中途断了 → 问一次服务端，还在跑就接回", async () => {
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
      // 没有收尾事件就关流了（代理掐断）
    })
    const wrapper = await mountOpened()
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const stream = controllableStream()

    await type(wrapper, "再改一次")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(stream.opened).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    stream.emit(finished)
    stream.end()
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("改好了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
  })

  it("在已有会话里发送被 409 → 再问一次服务端：是我在另一个标签页里对同一个会话发起的就接回", async () => {
    // 409 只会发生在给了会话 id 的时候（新会话总能发起）
    session.mockResolvedValueOnce(sessionView({ latest: view("c1") }))
    send.mockRejectedValue(new ApiError("busy", 409, null))
    const wrapper = await mountOpened()
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    controllableStream()

    await type(wrapper, "加一个节点")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(runEvents).toHaveBeenCalledWith("f1", "r1", expect.anything())
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
  })
})

describe("工具栏快捷输入", () => {
  async function mountQuick() {
    const wrapper = mount(HostWithQuick, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-testid="agent-quick-toggle"]').trigger("click")
    await flushPromises()
    return wrapper
  }

  function quickInput(wrapper: Awaited<ReturnType<typeof mountQuick>>) {
    return wrapper
      .findAllComponents(PromptInput)
      .find((item) => item.element.closest('[data-testid="agent-quick-prompt"]'))!
  }

  function quickSend() {
    return document.querySelector<HTMLButtonElement>('[data-testid="agent-quick-prompt"] [data-testid="agent-send"]')!
  }

  it("发出去 → 开新会话（conversationId 为 null）执行，弹层收起、对话框展开显示这一轮", async () => {
    session.mockResolvedValue(sessionView({ latest: view("c1") }))
    send.mockImplementation(async (_id: string, _body: unknown, options: SendOptions) => {
      options.onOpen?.()
      options.onEvent({ type: "RUN_STARTED", threadId: "c-new", runId: "r1" })
      // 流一直开着：这一轮还在跑
      return new Promise(() => {})
    })
    const wrapper = await mountQuick()
    expect(wrapper.get('[data-testid="agent-dialog"]').isVisible()).toBe(false)

    quickInput(wrapper).vm.$emit("update:modelValue", "画一个流程")
    await flushPromises()
    quickSend().click()
    await flushPromises()

    expect(send).toHaveBeenLastCalledWith("f1", { text: "画一个流程", conversationId: null }, expect.anything())
    expect(document.querySelector('[data-testid="agent-quick-prompt"]')).toBeNull()
    expect(wrapper.get('[data-testid="agent-dialog"]').isVisible()).toBe(true)
    expect(wrapper.text()).not.toContain("回答 c1")
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("画一个流程")
  })

  it("服务端没配模型 → 入口禁用", async () => {
    session.mockResolvedValue(sessionView({ enabled: false }))
    const wrapper = mount(HostWithQuick, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-quick-toggle"]').attributes("disabled")).toBeDefined()
  })

  it("别人的一轮在跑 → 快捷输入照常能发（新会话总能发起）", async () => {
    session.mockResolvedValue(
      sessionView({ activeRun: activeRun({ mine: false, owner: { id: "u2", name: "小王", avatarUrl: null } }) })
    )
    const wrapper = await mountQuick()
    quickInput(wrapper).vm.$emit("update:modelValue", "试试")
    await flushPromises()
    expect(quickSend().disabled).toBe(false)
  })
})

/**
 * 多人并行（docs/20 §3.10.3–§3.10.5）：任务列表只靠协同连接上的 `agent:runs` 推送更新（没有轮询），
 * 右上角按钮的角标 / 动效跟着它走；项目画布上别人的会话只读可见、标出发起人；个人画布不显示用户标识。
 */
describe("任务列表与多人会话", () => {
  const other = { id: "u2", name: "乙", avatarUrl: null }

  function entry(overrides: Partial<AgentRunEntry> = {}): AgentRunEntry {
    return {
      runId: "r1",
      conversationId: "c1",
      conversationTitle: "会话 c1",
      owner: { id: "me", name: "我", avatarUrl: null },
      startedAt: Date.now(),
      ...overrides
    }
  }

  async function mountClosed() {
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it("推送：解析后替换任务列表；别的画布的、读不懂的都丢掉（不抛）", async () => {
    const wrapper = await mountClosed()
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)

    await pushRuns([entry(), entry({ runId: "r2", conversationId: "c2", owner: other })])
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("2")

    // 换画布时的残留：flowId 对不上
    await pushRuns([], "f-other")
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("2")

    expect(() => pushPayload("{not json")).not.toThrow()
    expect(() => pushPayload(JSON.stringify({ type: "agent:runs", flowId: "f1", runs: "坏的" }))).not.toThrow()
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("2")

    // 全量替换：只剩一项
    await pushRuns([entry({ runId: "r2", conversationId: "c2", owner: other })])
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("1")
    expect(session).toHaveBeenCalledTimes(1)
  })

  it("推送里没有 mine：按当前用户的 id 算 —— 任务列表里只有自己的那行标「我的」", async () => {
    const wrapper = await mountClosed()
    await pushRuns([entry(), entry({ runId: "r2", conversationId: "c2", conversationTitle: "乙的活", owner: other })])
    await wrapper.get('[data-testid="agent-toggle"]').trigger("click")
    await flushPromises()

    expect(wrapper.find('[data-testid="agent-tasks"]').exists()).toBe(true)
    const mineRow = wrapper.get('[data-run-id="r1"]')
    const otherRow = wrapper.get('[data-run-id="r2"]')
    expect(mineRow.find('[data-role="mine"]').exists()).toBe(true)
    expect(otherRow.find('[data-role="mine"]').exists()).toBe(false)
    expect(otherRow.get('[data-role="owner-name"]').text()).toBe("乙")
    expect(otherRow.get('[data-role="title"]').text()).toBe("乙的活")
  })

  it("没开登录（拿不到当前用户）→ 从快照的 mine 学到自己的 id，推送照样算得出「我的」", async () => {
    authUser.value = null
    session.mockResolvedValue(sessionView({ activeRun: activeRun({ runId: "r0", conversationId: "c0" }) }))
    controllableStream()
    const wrapper = await mountClosed()
    await pushRuns([entry({ runId: "r5", conversationId: "c5" }), entry({ runId: "r6", conversationId: "c6", owner: other })])
    await wrapper.get('[data-testid="agent-toggle"]').trigger("click")
    await flushPromises()

    expect(wrapper.get('[data-run-id="r5"]').find('[data-role="mine"]').exists()).toBe(true)
    expect(wrapper.get('[data-run-id="r6"]').find('[data-role="mine"]').exists()).toBe(false)
  })

  it("没有轮询：别人一直在跑也不会定时问服务端；协同连接从断到通时补拉一次快照", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
    session.mockResolvedValue(sessionView({ activeRun: activeRun({ mine: false, owner: other, conversationId: "c9" }) }))
    await mountClosed()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(session).toHaveBeenCalledTimes(1)

    connected.value = true
    await flushPromises()
    expect(session).toHaveBeenCalledTimes(2)
    // 一直连着：不再拉
    await vi.advanceTimersByTimeAsync(120_000)
    expect(session).toHaveBeenCalledTimes(2)

    // 断了又连上：再补一次
    connected.value = false
    await flushPromises()
    connected.value = true
    await flushPromises()
    expect(session).toHaveBeenCalledTimes(3)
  })

  it("快照在途时收到了推送 → 以推送为准（快照里的列表更旧）", async () => {
    let resolve!: (view: AgentSessionView) => void
    session.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const wrapper = mount(Host, { attachTo: document.body })
    await pushRuns([entry(), entry({ runId: "r2", conversationId: "c2", owner: other })])
    resolve(sessionView())
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("2")
  })

  it("右上角按钮：0 个任务没有角标、没有动效；有任务时转圈（减少动态效果时隐藏）+ 角标，读屏标签带任务数", async () => {
    const wrapper = await mountClosed()
    const toggle = () => wrapper.get('[data-testid="agent-toggle"]')
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-run-ring"]').exists()).toBe(false)
    expect(toggle().attributes("aria-label")).toBe("画布 Agent")

    await pushRuns([entry(), entry({ runId: "r2", conversationId: "c2", owner: other })])
    expect(wrapper.get('[data-testid="agent-run-count"]').text()).toBe("2")
    const ring = wrapper.get('[data-testid="agent-run-ring"]')
    expect(ring.classes()).toContain("motion-safe:animate-spin")
    expect(ring.classes()).toContain("motion-reduce:hidden")
    expect(toggle().attributes("aria-label")).toBe("画布 Agent（2 个任务运行中）")

    await pushRuns([])
    expect(wrapper.find('[data-testid="agent-run-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-run-ring"]').exists()).toBe(false)
  })

  it("任务列表：已运行时长每秒走；点别人的那行 → 只读打开它的会话、旁观实时进度；成员没有停止按钮", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    vi.setSystemTime(Date.UTC(2026, 9, 1, 0, 0, 0))
    const wrapper = await mountClosed()
    await pushRuns([
      entry({ startedAt: Date.now() - 5_000 }),
      entry({ runId: "r2", conversationId: "c2", conversationTitle: "乙的活", owner: other, startedAt: Date.now() - 65_000 })
    ])
    await wrapper.get('[data-testid="agent-toggle"]').trigger("click")
    await flushPromises()

    const elapsed = () => wrapper.get('[data-run-id="r2"] [data-role="elapsed"]').text()
    expect(elapsed()).toBe("已运行 1 分 05 秒")
    await vi.advanceTimersByTimeAsync(2_000)
    expect(elapsed()).toBe("已运行 1 分 07 秒")
    vi.useRealTimers()

    const stream = controllableStream()
    conversation.mockResolvedValueOnce(
      view("c2", {
        title: "乙的活",
        owner: other,
        mine: false,
        running: true,
        messages: [{ id: "c2-u", role: "user", text: "乙的问题", createdAt: 1 }]
      })
    )
    await wrapper.get('[data-run-id="r2"] [data-role="select"]').trigger("click")
    await flushPromises()

    expect(conversation).toHaveBeenCalledWith("f1", "c2")
    expect(runEvents).toHaveBeenCalledWith("f1", "r2", expect.anything())
    // 「乙 · 乙的活」（间距是 gap，不是空格）
    expect(wrapper.get('[data-testid="agent-title"]').text()).toBe("乙·乙的活")
    expect(wrapper.get('[data-testid="agent-title"] [data-role="title-owner"]').text()).toBe("乙")
    expect(wrapper.get('[data-testid="agent-readonly"] [data-role="hint"]').text()).toBe("这是 乙 的会话，只能查看")
    expect(wrapper.findComponent(PromptInput).exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)

    stream.emit({ type: "RUN_STARTED", threadId: "c2", runId: "r2" })
    stream.emit({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" })
    stream.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "乙的 agent 在改" })
    await flushPromises()
    expect(lastAssistant(wrapper.get('[data-testid="agent-messages"]')).text()).toContain("乙的 agent 在改")

    // 「发起新会话」：回到自己的新会话，能发
    await wrapper.get('[data-testid="agent-readonly-new"]').trigger("click")
    await flushPromises()
    expect(stream.signal!.aborted).toBe(true)
    expect(abort).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="agent-title"]').text()).toBe("新会话")
    expect(wrapper.findComponent(PromptInput).exists()).toBe(true)
  })

  it("项目管理员看别人在跑的会话 → 有停止按钮，点了调 abort", async () => {
    myRole.value = "admin"
    session.mockResolvedValue(
      sessionView({ activeRun: activeRun({ runId: "r2", conversationId: "c2", owner: other, mine: false }) })
    )
    controllableStream()
    conversation.mockResolvedValue(view("c2", { owner: other, mine: false, running: true }))
    const wrapper = await mountOpened()

    // 只有 1 个任务、我又在新会话里：直接进它
    expect(conversation).toHaveBeenCalledWith("f1", "c2")
    expect(projectGet).toHaveBeenCalledWith("p1")
    await wrapper.get('[data-testid="agent-stop"]').trigger("click")
    await flushPromises()
    expect(abort).toHaveBeenCalledWith("f1", "r2")
  })

  it("只有 1 个任务、但我正在自己的会话里 → 打开面板不把我拽走（表头按钮能进任务列表）", async () => {
    session.mockResolvedValue(
      sessionView({ activeRun: activeRun({ runId: "r2", conversationId: "c2", owner: other, mine: false }), latest: view("c1") })
    )
    const wrapper = await mountOpened()

    expect(conversation).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("回答 c1")
    expect(wrapper.find('[data-testid="agent-tasks"]').exists()).toBe(false)

    await wrapper.get('[data-testid="agent-tasks-toggle"]').trigger("click")
    await flushPromises()
    expect(wrapper.find('[data-run-id="r2"]').exists()).toBe(true)
  })

  it("历史列表（项目画布）：每行有发起人和「我的」；别人的会话没有删除按钮", async () => {
    conversations.mockResolvedValue([summary("c1"), summary("c2", { owner: other, mine: false })])
    const wrapper = await mountOpened()
    await wrapper.get('[data-testid="agent-history-toggle"]').trigger("click")
    await flushPromises()

    const mineRow = wrapper.get('[data-conversation-id="c1"]')
    const otherRow = wrapper.get('[data-conversation-id="c2"]')
    expect(mineRow.find('[data-role="mine"]').exists()).toBe(true)
    expect(mineRow.find('[data-role="delete"]').exists()).toBe(true)
    expect(otherRow.get('[data-role="owner-name"]').text()).toBe("乙")
    expect(otherRow.find('[data-role="mine"]').exists()).toBe(false)
    expect(otherRow.find('[data-role="delete"]').exists()).toBe(false)
  })

  it("个人画布：历史、任务列表、头部都不显示用户标识，也不问项目角色", async () => {
    mode.value = "solo"
    conversations.mockResolvedValue([summary("c1")])
    const wrapper = await mountClosed()
    await pushRuns([entry(), entry({ runId: "r2", conversationId: "c2" })])
    await wrapper.get('[data-testid="agent-toggle"]').trigger("click")
    await flushPromises()

    expect(wrapper.find('[data-testid="agent-tasks"]').exists()).toBe(true)
    expect(wrapper.find('[data-role="owner"]').exists()).toBe(false)
    expect(wrapper.find('[data-role="mine"]').exists()).toBe(false)

    await wrapper.get('[data-testid="agent-history-toggle"]').trigger("click")
    await flushPromises()
    expect(wrapper.find('[data-conversation-id="c1"]').exists()).toBe(true)
    expect(wrapper.find('[data-role="owner"]').exists()).toBe(false)
    expect(projectGet).not.toHaveBeenCalled()
  })
})
