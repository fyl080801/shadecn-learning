import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import type {
  AgentActiveRunView,
  AgentConversationSummary,
  AgentConversationView,
  AgentSessionView,
  AgentStreamEvent
} from "@shadecn/shared/agent"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import PromptInput from "@/components/prompt-input/PromptInput.vue"

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
      }
    }
  })
}))

// <Panel> 要一个 Vue Flow 实例才能定位；这里只关心里面的内容
vi.mock("@vue-flow/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vue-flow/core")>()),
  Panel: defineComponent({
    setup(_, { slots }) {
      return () => h("div", { "data-stub": "panel" }, slots.default?.())
    }
  })
}))

const toastError = vi.fn()
vi.mock("vue-sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), warning: vi.fn() }
}))

const session = vi.fn<(id: string) => Promise<AgentSessionView>>()
const send = vi.fn()
const runEvents = vi.fn()
const abort = vi.fn<(id: string) => Promise<void>>()
const conversations = vi.fn<(id: string) => Promise<AgentConversationSummary[]>>()
const conversation = vi.fn<(id: string, cid: string) => Promise<AgentConversationView>>()
const deleteConversation = vi.fn<(id: string, cid: string) => Promise<void>>()

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agentApi: {
    session: (id: string) => session(id),
    send: (...args: unknown[]) => send(...args),
    runEvents: (...args: unknown[]) => runEvents(...args),
    abort: (id: string) => abort(id),
    conversations: (id: string) => conversations(id),
    conversation: (id: string, cid: string) => conversation(id, cid),
    deleteConversation: (id: string, cid: string) => deleteConversation(id, cid)
  }
}))

const { ApiError } = await import("@/lib/api")
const { formatDateTime } = await import("@/lib/format")
const { default: FlowAgentChat } = await import("@/components/flow/agent/FlowAgentChat.vue")
const { AGENT_POLL_INTERVAL, AGENT_RESUME_RETRY_DELAY } = await import("@/composables/flow/useFlowAgent")

function sessionView(overrides: Partial<AgentSessionView> = {}): AgentSessionView {
  const view: AgentSessionView = {
    enabled: true,
    running: false,
    activeRun: null,
    latest: null,
    ...overrides
  }
  return { ...view, running: view.activeRun !== null }
}

function activeRun(overrides: Partial<AgentActiveRunView> = {}): AgentActiveRunView {
  return {
    runId: "r1",
    conversationId: "c1",
    initiator: { id: "me", name: "我" },
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
    running: false,
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
  return { id, type: "text", position: { x: 0, y: 0 }, data: { label, status: "idle", text: "" } } as FlowNode
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
  const wrapper = mount(FlowAgentChat, { attachTo: document.body })
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
  toastError.mockReset()
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
    // 运行中：发送换成停止，收起按钮上挂着运行中标记，输入框已经清空
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-running-badge"]').exists()).toBe(true)
    expect(wrapper.findComponent(PromptInput).props("modelValue")).toBe("")

    finish()
    await flushPromises()

    expect(list.get('[data-tool-status="done"]').text()).toContain("改写节点 开场白")
    expect(list.get('[data-role="assistant"]').text()).toContain("改完了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-running-badge"]').exists()).toBe(false)
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
    expect(abort).toHaveBeenCalledWith("f1")
  })

  it("409 → toast 说明有人在跑；用户那条撤回，输入框里的字还回来", async () => {
    send.mockRejectedValue(new ApiError("busy", 409, null))
    const wrapper = await mountOpened()
    await type(wrapper, "加一个节点")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith("这张画布上有一轮 agent 正在运行，等它结束再发")
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

  it("运行中：新会话按钮禁用，历史列表里切到别的会话也禁用", async () => {
    session.mockResolvedValue(sessionView({ latest: view("c1") }))
    conversations.mockResolvedValue([summary("c1"), summary("c2")])
    send.mockImplementation(
      (_id: string, _body: unknown, options: SendOptions) =>
        new Promise<void>(() => {
          options.onOpen?.()
          options.onEvent({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
        })
    )
    const wrapper = await mountOpened()
    await type(wrapper, "跑着")
    await wrapper.get('[data-testid="agent-send"]').trigger("click")
    await flushPromises()

    expect(wrapper.get('[data-testid="agent-new"]').attributes("disabled")).toBeDefined()

    await wrapper.get('[data-testid="agent-history-toggle"]').trigger("click")
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-history-locked"]').exists()).toBe(true)
    const other = wrapper.get('[data-conversation-id="c2"] [data-role="select"]')
    expect(other.attributes("disabled")).toBeDefined()
    expect(wrapper.get('[data-conversation-id="c1"] [data-role="select"]').attributes("disabled")).toBeUndefined()
    expect(conversation).not.toHaveBeenCalled()
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
    // 运行中：停止按钮可用，收起按钮挂着运行中标记，不能新建会话
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-running-badge"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-new"]').attributes("disabled")).toBeDefined()

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
    expect(wrapper.find('[data-testid="agent-running-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-send"]').exists()).toBe(true)
  })

  it("我的一轮刚发起、会话还没建好（conversationId 为 null）→ 不拿 latest 去接，稍等再问", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    // 这时的 latest 还是上一个会话 —— 接上去就会把这一轮折叠进错的会话
    session.mockResolvedValueOnce(
      sessionView({ activeRun: activeRun({ conversationId: null }), latest: view("c0") })
    )
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const stream = controllableStream()
    const wrapper = await mountOpened()

    expect(runEvents).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_RESUME_RETRY_DELAY)
    await flushPromises()

    expect(runEvents).toHaveBeenCalledTimes(1)
    stream.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    stream.emit(finished)
    stream.end()
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("改好了")
    expect(wrapper.text()).not.toContain("回答 c0")
  })

  it("补发的 RUN_STARTED 说这一轮属于另一个会话 → 不折叠进当前会话，重新问一次再接", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    session.mockResolvedValueOnce(
      sessionView({ activeRun: activeRun({ conversationId: "c0" }), latest: view("c0") })
    )
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    const first = controllableStream()
    const wrapper = await mountOpened()

    first.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    first.emit({ type: "TEXT_MESSAGE_START", messageId: "a-run", role: "assistant" })
    first.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "a-run", delta: "不该出现在 c0 里" })
    await flushPromises()
    expect(first.signal!.aborted).toBe(true)
    expect(wrapper.text()).not.toContain("不该出现在 c0 里")

    const second = controllableStream()
    await vi.advanceTimersByTimeAsync(AGENT_RESUME_RETRY_DELAY)
    await flushPromises()
    expect(runEvents).toHaveBeenCalledTimes(2)
    second.emit({ type: "RUN_STARTED", threadId: "c1", runId: "r1" })
    second.emit(finished)
    second.end()
    await flushPromises()
    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("改好了")
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
    expect(abort).toHaveBeenCalledWith("f1")
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

  it("接回时 410（补发缓冲溢出）→ 不报错，轮询到那一轮结束再拉会话", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    session.mockResolvedValue(sessionView({ activeRun: activeRun(), latest: runningConversation() }))
    runEvents.mockRejectedValue(new ApiError("gone", 410, null))
    const wrapper = await mountOpened()

    // 还在跑：停止按钮照样在（服务端那一轮是真的在跑），只是看不到过程
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(true)
    expect(session).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL)
    await flushPromises()
    // 第二次还在跑：同一轮不再去订阅（否则「接回 → 410 → 接回」空转）
    expect(session).toHaveBeenCalledTimes(2)
    expect(runEvents).toHaveBeenCalledTimes(1)

    session.mockResolvedValue(
      sessionView({
        latest: view("c1", {
          messages: [
            ...runningConversation().messages,
            { id: "a-run", role: "assistant", text: "终于改好了", toolCalls: [], createdAt: 4 }
          ]
        })
      })
    )
    await vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL)
    await flushPromises()

    expect(wrapper.get('[data-testid="agent-messages"]').text()).toContain("终于改好了")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    expect(toastError).not.toHaveBeenCalled()

    // 结束了就不再轮询
    await vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL * 3)
    expect(session).toHaveBeenCalledTimes(3)
  })

  it("别人发起的一轮在跑 → 提示是谁、发送禁用；轮询到它结束后解除", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    session.mockResolvedValue(
      sessionView({
        activeRun: activeRun({ mine: false, conversationId: null, initiator: { id: "u2", name: "乙" } }),
        latest: view("c1")
      })
    )
    const wrapper = await mountOpened()

    expect(runEvents).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="agent-foreign-run"]').text()).toContain("乙 发起的 agent 正在运行")
    // 我自己的会话照常显示，但不能发、也没有可停的
    expect(wrapper.text()).toContain("回答 c1")
    expect(wrapper.find('[data-testid="agent-stop"]').exists()).toBe(false)
    await type(wrapper, "加一个节点")
    expect(wrapper.get('[data-testid="agent-send"]').attributes("disabled")).toBeDefined()

    session.mockResolvedValue(sessionView({ latest: view("c1") }))
    await vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL)
    await flushPromises()

    expect(wrapper.find('[data-testid="agent-foreign-run"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="agent-send"]').attributes("disabled")).toBeUndefined()
    // 草稿还在：解除锁定不该顺手清掉用户打好的字
    expect(wrapper.findComponent(PromptInput).props("modelValue")).toBe("加一个节点")
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
    expect(wrapper.find('[data-testid="agent-running-badge"]').exists()).toBe(false)
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

  it("发送被 409 → 再问一次服务端：是我在另一个标签页发起的就接回", async () => {
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
