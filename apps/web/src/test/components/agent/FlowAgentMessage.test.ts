import { describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import type { AgentChatMessage, AgentReasoningView, AgentToolCallView, AgentUsageView } from "@shadecn/shared/agent"

/**
 * assistant 消息的 ai-elements 画法：过程时间线（思考段按位置插在工具调用之间）、工具调用展开看参数 / 结果、
 * 思考在想时展开 + 「思考中」、想完收起 + 时长、脚注的用量。真的挂组件，只把编辑器上下文打桩（提及 badge 要查节点名）。
 */

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({ store: { nodeById: new Map() } })
}))

const { default: FlowAgentMessage } = await import("@/components/flow/agent/FlowAgentMessage.vue")

function assistant(patch: Partial<Extract<AgentChatMessage, { role: "assistant" }>> = {}): AgentChatMessage {
  return { id: "a1", role: "assistant", text: "", toolCalls: [], createdAt: 1, ...patch }
}

const call = (id: string, patch: Partial<AgentToolCallView> = {}): AgentToolCallView => ({
  id,
  name: "add_node",
  summary: `调用 ${id}`,
  status: "done",
  ...patch
})

const thought = (id: string, position: number, patch: Partial<AgentReasoningView> = {}): AgentReasoningView => ({
  id,
  text: `想 ${id}`,
  position,
  startedAt: 1000,
  finishedAt: 4000,
  ...patch
})

describe("assistant 消息（ai-elements）", () => {
  it("时间线：思考段按 position 插在工具调用之间，越界的排最后；正文在时间线之后", () => {
    const wrapper = mount(FlowAgentMessage, {
      props: {
        message: assistant({
          text: "做完了",
          toolCalls: [call("t1"), call("t2")],
          reasoning: [thought("r0", 0), thought("r2", 2), thought("r1", 1), thought("r9", 9)]
        })
      }
    })
    const steps = wrapper.get('[data-role="assistant-steps"]').element.children
    const order = [...steps].map((item) =>
      item.getAttribute("data-role") === "reasoning" ? "思考" : (item.querySelector('[data-slot="trace-title"]')?.textContent ?? "")
    )
    expect(order).toEqual(["思考", "调用 t1", "思考", "调用 t2", "思考", "思考"])
    expect(wrapper.text().indexOf("做完了")).toBeGreaterThan(wrapper.text().indexOf("调用 t2"))
  })

  it("工具调用：有参数 / 结果时可展开，参数和结果各一块；旧记录（只有那句话）只是一行", async () => {
    const wrapper = mount(FlowAgentMessage, {
      props: {
        message: assistant({
          toolCalls: [
            call("t1", { input: '{"label":"X"}', output: "新建了 n1" }),
            call("t2", { status: "error", error: "节点不存在" }),
            call("t3")
          ]
        })
      }
    })
    const [withDetails, failed, legacy] = wrapper.findAll('[data-role="tool-call"]')
    expect(withDetails!.attributes("data-slot")).toBe("trace-collapsible")
    expect(legacy!.attributes("data-slot")).toBe("trace-line")
    expect(failed!.attributes("data-tool-status")).toBe("error")
    expect(failed!.find('[data-status="error"]').exists()).toBe(true)

    await withDetails!.get("button").trigger("click")
    await flushPromises()
    const details = withDetails!.findAll('[data-role="tool-detail"]')
    expect(details.map((item) => item.attributes("data-detail"))).toEqual(["参数", "结果"])
    // 能解析的 JSON 缩进排版
    expect(details[0]!.text()).toContain('"label": "X"')
    expect(details[1]!.text()).toContain("新建了 n1")

    await failed!.get("button").trigger("click")
    await flushPromises()
    expect(failed!.get('[data-role="tool-error"]').text()).toContain("节点不存在")
  })

  it("思考：在想时展开、标题「思考中」带 running；想完收起、标题「思考过程」+ 时长", async () => {
    const wrapper = mount(FlowAgentMessage, {
      props: { message: assistant({ reasoning: [thought("r0", 0, { finishedAt: undefined })] }), streaming: true }
    })
    const running = wrapper.get('[data-role="reasoning"]')
    expect(running.attributes("data-reasoning-status")).toBe("running")
    expect(running.attributes("data-state")).toBe("open")
    expect(running.get('[data-slot="trace-line"]').attributes("data-status")).toBe("running")
    expect(running.text()).toContain("思考中")
    expect(running.get('[data-role="reasoning-text"]').text()).toBe("想 r0")
    // 有思考了就不再垫「思考中…」那一行
    expect(wrapper.find('[data-role="assistant-waiting"]').exists()).toBe(false)

    await wrapper.setProps({ message: assistant({ reasoning: [thought("r0", 0)] }) })
    const done = wrapper.get('[data-role="reasoning"]')
    expect(done.attributes("data-state")).toBe("closed")
    expect(done.text()).toContain("思考过程")
    expect(done.get('[data-slot="trace-description"]').text()).toBe("3 秒")
  })

  it("工具调用之间说的话按位置排进时间线，最后一条工具调用之后的是正文；旧记录（没有分段）整段是正文", () => {
    const text = "先看看画布\n\n画布是空的\n\n做好了"
    const wrapper = mount(FlowAgentMessage, {
      props: {
        message: assistant({
          text,
          toolCalls: [call("t1"), call("t2")],
          textSegments: [
            { at: 0, position: 0 },
            { at: 5, position: 1 },
            { at: 12, position: 2 }
          ]
        })
      }
    })
    const steps = [...wrapper.get('[data-role="assistant-steps"]').element.children].map((item) =>
      item.getAttribute("data-role") === "assistant-interim" ? `说：${item.textContent?.trim()}` : (item.querySelector('[data-slot="trace-title"]')?.textContent ?? "")
    )
    expect(steps).toEqual(["说：先看看画布", "调用 t1", "说：画布是空的", "调用 t2"])
    const after = wrapper.get('[data-role="assistant-steps"]').element.nextElementSibling
    expect(after?.textContent).toContain("做好了")
    expect(after?.textContent).not.toContain("画布是空的")

    const legacy = mount(FlowAgentMessage, { props: { message: assistant({ text, toolCalls: [call("t1")] }) } })
    expect(legacy.findAll('[data-role="assistant-interim"]')).toHaveLength(0)
    expect(legacy.text()).toContain("画布是空的")
  })

  it("刚开流什么都没有：垫一行「思考中…」", () => {
    const wrapper = mount(FlowAgentMessage, { props: { message: assistant(), streaming: true } })
    expect(wrapper.get('[data-role="assistant-waiting"]').text()).toBe("思考中…")
  })

  it("用量：脚注里只有上下文占比", () => {
    const usage: AgentUsageView = {
      inputTokens: 12_000,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      contextTokens: 12_800,
      contextWindow: 128_000,
      model: "test-model"
    }
    const wrapper = mount(FlowAgentMessage, { props: { message: assistant({ text: "好", usage }) } })
    const trigger = wrapper.get('[data-role="usage"]')
    expect(trigger.text()).toBe("10% 上下文")
    expect(trigger.attributes("aria-label")).toBe("上下文已用 10%")
    // 旧记录没有用量：不画
    expect(mount(FlowAgentMessage, { props: { message: assistant({ text: "好" }) } }).find('[data-role="usage"]').exists()).toBe(false)
  })

  it("用户消息画成靠右的气泡", () => {
    const wrapper = mount(FlowAgentMessage, { props: { message: { id: "u1", role: "user", text: "加个节点", createdAt: 1 } } })
    const bubble = wrapper.get('[data-slot="bubble"]')
    expect(bubble.attributes("data-align")).toBe("end")
    expect(bubble.get('[data-role="user-text"]').text()).toBe("加个节点")
  })
})
