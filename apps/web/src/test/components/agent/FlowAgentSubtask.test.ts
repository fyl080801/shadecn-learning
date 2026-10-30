import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { ref } from "vue"
import type { AgentChatMessage, AgentSubtaskView, AgentToolCallView } from "@shadecn/shared/agent"
import type { FlowNode } from "@shadecn/shared/flow-graph"

/**
 * 父会话里的子任务条目（docs/20 §3.10.11）：`delegate_task` 那条工具调用画成可展开的条目（任务说明、状态、已运行时长；
 * 展开看子 agent 的工具调用、问题 / 原因和最终回复，只读）；没派出去的 delegate_task 仍是普通的出错工具调用。
 * 任务列表那一行带「含 N 个子任务进行中」。真的挂组件，只把编辑器上下文打桩（提及 badge 要查节点名）。
 */

const nodes = ref<FlowNode[]>([])
vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    store: {
      get nodeById() {
        return new Map(nodes.value.map((item) => [item.id, item]))
      }
    }
  })
}))

const { default: FlowAgentMessage } = await import("@/components/flow/agent/FlowAgentMessage.vue")
const { default: FlowAgentTasks } = await import("@/components/flow/agent/FlowAgentTasks.vue")
const { TooltipProvider } = await import("@/components/ui/tooltip")
const { h } = await import("vue")

const task = (patch: Partial<AgentSubtaskView> = {}): AgentSubtaskView => ({
  id: "sub_1",
  toolCallId: "call_a",
  brief: "给导演台 A 搭一个场景",
  nodeIds: ["d1"],
  status: "running",
  startedAt: Date.now() - 65_000,
  toolCalls: [{ id: "t1", name: "add_objects", summary: "新建 2 个对象", status: "done" }],
  text: "",
  changedNodeIds: [],
  ...patch
})

function message(subtasks: AgentSubtaskView[], extraCalls: AgentToolCallView[] = []): AgentChatMessage {
  return {
    id: "a1",
    role: "assistant",
    text: "",
    createdAt: 1,
    toolCalls: [
      ...subtasks.map((item) => ({ id: item.toolCallId, name: "delegate_task", summary: `子任务：${item.brief}`, status: "running" as const })),
      ...extraCalls
    ],
    subtasks
  }
}

describe("子任务条目", () => {
  it("delegate_task 画成子任务条目：说明、状态、已运行时长；展开后有子 agent 的工具调用和最终回复；没派出去的仍是普通工具调用", async () => {
    const wrapper = mount(FlowAgentMessage, {
      props: {
        message: message(
          [
            task(),
            task({ id: "sub_2", toolCallId: "call_b", brief: "B", status: "done", startedAt: 1_000, finishedAt: 61_000, text: "**搭好了**", changedNodeIds: ["d2"] }),
            task({ id: "sub_3", toolCallId: "call_c", brief: "C", status: "needs_confirmation", question: "要等对方吗？", finishedAt: Date.now() }),
            task({ id: "sub_4", toolCallId: "call_e", brief: "D", status: "failed", error: "上游炸了", finishedAt: Date.now() })
          ],
          [{ id: "call_x", name: "delegate_task", summary: "子任务：被拒的", status: "error", error: "同时最多 3 个子任务在跑" }]
        )
      }
    })
    const items = wrapper.findAll('[data-role="subtask"]')
    expect(items.map((item) => item.attributes("data-subtask-status"))).toEqual(["running", "done", "needs_confirmation", "failed"])
    expect(items[0]!.find('[data-role="subtask-brief"]').text()).toBe("给导演台 A 搭一个场景")
    expect(items[0]!.find('[data-role="subtask-status"]').text()).toContain("进行中")
    expect(items[0]!.find('[data-role="subtask-elapsed"]').text()).toMatch(/已运行 1 分 0[0-9] 秒/)
    expect(items[1]!.find('[data-role="subtask-elapsed"]').text()).toMatch(/已运行 1 分 00 秒/)
    expect(items[2]!.find('[data-role="subtask-status"]').text()).toContain("需要确认")
    expect(items[2]!.find('[data-role="subtask-question"]').text()).toBe("要等对方吗？")
    expect(items[3]!.find('[data-role="subtask-error"]').text()).toBe("上游炸了")
    // 工具调用和最终回复在展开区里（只读；回复按 Markdown 渲染）
    expect(items[0]!.find('[data-role="subtask-tools"]').text()).toContain("新建 2 个对象")
    expect(items[1]!.find('[data-role="subtask-reply"] strong').text()).toBe("搭好了")
    expect(items[1]!.find('[data-mention-id="d2"]').exists()).toBe(true)
    // 被拒、没派出去的 delegate_task 没有条目：照常是一条出错的工具调用
    const plain = wrapper.findAll("[data-tool-status]").filter((item) => item.text().includes("被拒的"))
    expect(plain).toHaveLength(1)
    expect(plain[0]!.attributes("data-tool-status")).toBe("error")
    // 只读：条目里没有输入框 / 按钮
    expect(items[0]!.find("textarea, input, button").exists()).toBe(false)
  })

  it("任务列表：带子任务的那一行显示「含 N 个子任务进行中」，没有的不显示", () => {
    const run = (runId: string, subtasks?: number) => ({
      runId,
      conversationId: `c_${runId}`,
      conversationTitle: runId,
      owner: { id: "u1", name: "甲", avatarUrl: null },
      startedAt: Date.now(),
      occupies: [],
      mine: true,
      ...(subtasks ? { subtasks } : {})
    })
    const wrapper = mount({
      render: () => h(TooltipProvider, null, () => h(FlowAgentTasks, { runs: [run("r1", 2), run("r2")], showOwners: false, currentId: null }))
    })
    const rows = wrapper.findAll("[data-run-id]")
    expect(rows[0]!.find('[data-role="subtasks"]').text()).toBe("含 2 个子任务进行中")
    expect(rows[1]!.find('[data-role="subtasks"]').exists()).toBe(false)
  })
})
