import { describe, expect, it } from "vitest"
import type { AgentChatMessage, AgentStreamEvent } from "@shadecn/shared/agent"
import {
  RUN_CANCELLED_TEXT,
  STREAM_INTERRUPTED_TEXT,
  applyAgentEvent,
  beginTurn,
  emptyConversation,
  interruptTurn,
  resumeTurn,
  rollbackTurn
} from "@/lib/agent-conversation"

/**
 * 事件流 → 对话列表。这些错都不会抛异常，只会让界面看着不对：
 * 一轮的几段文字拼成了两条消息、工具圈永远在转、落定消息没盖掉本地拼的那份。
 */

const optimistic = { id: "local-1", role: "user", text: "你好", createdAt: 1 } as const

function turn(events: AgentStreamEvent[]) {
  const conversation = emptyConversation()
  beginTurn(conversation, { ...optimistic })
  for (const event of events) applyAgentEvent(conversation, event)
  return conversation
}

const started: AgentStreamEvent = { type: "RUN_STARTED", threadId: "f1", runId: "r1" }
const echoed: AgentStreamEvent = {
  type: "CUSTOM",
  name: "agent.user-message",
  value: { id: "u1", role: "user", text: "你好", createdAt: 2 }
}

describe("画布 Agent 的对话折叠", () => {
  it("服务端回显的用户消息替换乐观插入的那条，不会多出一条", () => {
    const conversation = turn([started, echoed])
    expect(conversation.messages).toEqual([{ id: "u1", role: "user", text: "你好", createdAt: 2 }])
    expect(conversation.runId).toBe("r1")
  })

  it("同一个 messageId 的几段文字拼进同一条 assistant 消息，工具调用挂在它上面", () => {
    const conversation = turn([
      started,
      echoed,
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "好的，" },
      { type: "TEXT_MESSAGE_END", messageId: "a1" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "add_node",
        parentMessageId: "a1",
        metadata: { summary: "新建节点 开场", status: "running" }
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tm1",
        toolCallId: "t1",
        content: "ok",
        role: "tool",
        metadata: { summary: "新建节点 开场", status: "done" }
      },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "已经加好了" }
    ])

    expect(conversation.messages).toHaveLength(2)
    const assistant = conversation.messages[1] as Extract<AgentChatMessage, { role: "assistant" }>
    expect(assistant.text).toBe("好的，已经加好了")
    expect(assistant.toolCalls).toEqual([
      { id: "t1", name: "add_node", summary: "新建节点 开场", status: "done" }
    ])
  })

  it("工具失败：状态和原因都落到条目上", () => {
    const conversation = turn([
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "delete_node",
        parentMessageId: "a1",
        metadata: { summary: "删除节点", status: "running" }
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tm1",
        toolCallId: "t1",
        content: "not found",
        role: "tool",
        metadata: { summary: "删除节点", status: "error", error: "节点不存在" }
      }
    ])
    const assistant = conversation.messages[1] as Extract<AgentChatMessage, { role: "assistant" }>
    expect(assistant.toolCalls[0]).toMatchObject({ status: "error", error: "节点不存在" })
  })

  it("RUN_FINISHED 带的落定消息覆盖本地拼出来的那份", () => {
    const conversation = turn([
      started,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "半截" },
      {
        type: "RUN_FINISHED",
        threadId: "f1",
        runId: "r1",
        outcome: { type: "success" },
        result: { id: "a1", role: "assistant", text: "完整回复", toolCalls: [], createdAt: 9 }
      }
    ])
    expect(conversation.messages[1]).toEqual({
      id: "a1",
      role: "assistant",
      text: "完整回复",
      toolCalls: [],
      createdAt: 9
    })
    expect(conversation.finished).toBe(true)
  })

  it("以 cancelled 收尾 = 已中止，服务端没写原因时补一句", () => {
    const conversation = turn([
      started,
      {
        type: "RUN_FINISHED",
        threadId: "f1",
        runId: "r1",
        outcome: { type: "cancelled" },
        result: { id: "a1", role: "assistant", text: "", toolCalls: [], createdAt: 9 }
      }
    ])
    expect(conversation.messages[1]).toMatchObject({ error: RUN_CANCELLED_TEXT })
  })

  it("RUN_ERROR：还在转的工具一律停下，原因挂在消息上；还没开口就失败也有一条消息说明", () => {
    const withTool = turn([
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "add_node",
        parentMessageId: "a1",
        metadata: { summary: "新建节点", status: "running" }
      },
      { type: "RUN_ERROR", message: "模型超时" }
    ])
    expect(withTool.messages[1]).toMatchObject({ error: "模型超时" })
    expect((withTool.messages[1] as { toolCalls: Array<{ status: string }> }).toolCalls[0]?.status).toBe(
      "error"
    )

    const silent = turn([started, { type: "RUN_ERROR", message: "额度用完了" }])
    expect(silent.messages).toHaveLength(2)
    expect(silent.messages[1]).toMatchObject({ role: "assistant", error: "额度用完了" })
  })

  it("流断了没等到收尾事件 → 标成中断；已经收尾的不受影响", () => {
    const broken = turn([started, { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "写到一半" }])
    interruptTurn(broken)
    expect(broken.messages[1]).toMatchObject({ text: "写到一半", error: STREAM_INTERRUPTED_TEXT })

    const done = turn([
      started,
      {
        type: "RUN_FINISHED",
        threadId: "f1",
        runId: "r1",
        outcome: { type: "success" },
        result: { id: "a1", role: "assistant", text: "好了", toolCalls: [], createdAt: 9 }
      }
    ])
    interruptTurn(done)
    expect(done.messages[1]).not.toHaveProperty("error")
  })

  it("这一轮根本没开始 → 乐观插入的那条撤回", () => {
    const conversation = emptyConversation([{ id: "old", role: "user", text: "上一轮", createdAt: 0 }])
    beginTurn(conversation, { ...optimistic })
    rollbackTurn(conversation)
    expect(conversation.messages.map((message) => message.id)).toEqual(["old"])
  })

  it("画布改动通知（agent.canvas-change）：追加到末尾、按 id 去重；之后的文字仍拼进同一条 assistant", () => {
    const change = {
      id: "chg1",
      role: "canvas-change",
      scope: "live",
      summary: "爱丽丝 改动了画布（1 处）",
      items: ["新建节点 text「A」（a）"],
      actors: ["爱丽丝"],
      omitted: 0,
      createdAt: 3
    } as const
    const event: AgentStreamEvent = { type: "CUSTOM", name: "agent.canvas-change", value: { ...change, items: [...change.items], actors: [...change.actors] } }
    const conversation = turn([
      started,
      echoed,
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "先看看" },
      event,
      event,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "，看到了" }
    ])
    expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant", "canvas-change"])
    expect(conversation.messages[1]).toMatchObject({ text: "先看看，看到了" })
    expect(conversation.messages[2]).toEqual(change)
  })

  it("技能加载（agent.skill-loaded）：追加到末尾、按 id 去重；名字和 role 对不上的不收", () => {
    const loaded = { id: "skl1", role: "skill-loaded", skill: { id: "media-view", title: "查看素材" }, createdAt: 3 } as const
    const event: AgentStreamEvent = { type: "CUSTOM", name: "agent.skill-loaded", value: { ...loaded, skill: { ...loaded.skill } } }
    const wrong = {
      type: "CUSTOM",
      name: "agent.skill-loaded",
      value: { id: "x", role: "canvas-change", scope: "live", summary: "", items: [], actors: [], omitted: 0, createdAt: 4 }
    } as unknown as AgentStreamEvent
    const conversation = turn([
      started,
      echoed,
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "先加载" },
      event,
      event,
      wrong,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "，再看" }
    ])
    expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant", "skill-loaded"])
    expect(conversation.messages[1]).toMatchObject({ text: "先加载，再看" })
    expect(conversation.messages[2]).toEqual(loaded)
  })

  it("认不出的事件类型直接忽略", () => {
    const conversation = turn([started, { type: "STATE_SNAPSHOT" } as unknown as AgentStreamEvent])
    expect(conversation.messages).toHaveLength(1)
  })
})

describe("接回一轮", () => {
  /** 已落库的这一轮用户消息是最后一条；补发的回显与它同 id，不能再插一条 */
  it("补发的用户消息回显按 id 替换已有那条，后续事件照常拼出 assistant", () => {
    const stored: AgentChatMessage[] = [
      { id: "u0", role: "user", text: "上一轮", createdAt: 1 },
      { id: "a0", role: "assistant", text: "上一轮的回答", toolCalls: [], createdAt: 2 },
      { id: "u1", role: "user", text: "这一轮", createdAt: 3 }
    ]
    const conversation = emptyConversation([...stored])
    resumeTurn(conversation, "r1")
    for (const event of [
      started,
      { type: "CUSTOM", name: "agent.user-message", value: { ...stored[2]! } },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "好" }
    ] as AgentStreamEvent[]) {
      applyAgentEvent(conversation, event)
    }

    expect(conversation.messages.map((message) => message.id)).toEqual(["u0", "a0", "u1", "a1"])
    expect(conversation.messages[3]).toMatchObject({ role: "assistant", text: "好" })
    expect(conversation.finished).toBe(false)
  })

  it("没有收尾就断了 → 和发起时一样标成中断", () => {
    const conversation = emptyConversation([{ id: "u1", role: "user", text: "这一轮", createdAt: 3 }])
    resumeTurn(conversation, "r1")
    interruptTurn(conversation)
    expect(conversation.messages[conversation.messages.length - 1]).toMatchObject({ role: "assistant", error: STREAM_INTERRUPTED_TEXT })
  })
})

describe("子任务条目（docs/20 §3.10.11）", () => {
  const delegateStart: AgentStreamEvent = {
    type: "TOOL_CALL_START",
    toolCallId: "call_d",
    toolCallName: "delegate_task",
    parentMessageId: "a1",
    metadata: { summary: "子任务：搭场景", status: "running" }
  }
  const subtask = (patch: Record<string, unknown> = {}): AgentStreamEvent =>
    ({
      type: "CUSTOM",
      name: "agent.subtask",
      value: {
        id: "sub_1",
        toolCallId: "call_d",
        brief: "搭场景",
        nodeIds: ["d1"],
        status: "running",
        startedAt: 10,
        toolCalls: [],
        text: "",
        changedNodeIds: [],
        ...patch
      }
    }) as AgentStreamEvent

  it("每帧按 id 整条替换进本轮 assistant 消息的 subtasks；补发里重复的帧不会多出一条", () => {
    const conversation = turn([
      started,
      echoed,
      delegateStart,
      subtask(),
      subtask({ toolCalls: [{ id: "t1", name: "add_node", summary: "新建", status: "running" }] }),
      subtask({ status: "done", text: "好了", finishedAt: 20, changedNodeIds: ["n1"], toolCalls: [{ id: "t1", name: "add_node", summary: "新建", status: "done" }] })
    ])
    const assistant = conversation.messages.find((message) => message.role === "assistant") as Extract<AgentChatMessage, { role: "assistant" }>
    expect(assistant.toolCalls.map((call) => call.name)).toEqual(["delegate_task"])
    expect(assistant.subtasks).toEqual([
      expect.objectContaining({ id: "sub_1", status: "done", text: "好了", finishedAt: 20, changedNodeIds: ["n1"] })
    ])
  })

  it("畸形的帧丢掉、不抛；RUN_ERROR / 中断时还在跑的子任务标成失败", () => {
    const conversation = turn([
      started,
      echoed,
      delegateStart,
      subtask(),
      { type: "CUSTOM", name: "agent.subtask", value: { id: "bad" } } as unknown as AgentStreamEvent,
      { type: "RUN_ERROR", message: "炸了" }
    ])
    const assistant = conversation.messages.find((message) => message.role === "assistant") as Extract<AgentChatMessage, { role: "assistant" }>
    expect(assistant.subtasks).toHaveLength(1)
    expect(assistant.subtasks![0]).toMatchObject({ status: "failed" })
  })

  it("落定消息（RUN_FINISHED）里的子任务替换本地拼的那份", () => {
    const conversation = turn([
      started,
      echoed,
      delegateStart,
      subtask(),
      {
        type: "RUN_FINISHED",
        threadId: "f1",
        runId: "r1",
        outcome: { type: "success" },
        result: {
          id: "a1",
          role: "assistant",
          text: "都好了",
          toolCalls: [{ id: "call_d", name: "delegate_task", summary: "子任务完成", status: "done" }],
          createdAt: 3,
          subtasks: [
            { id: "sub_1", toolCallId: "call_d", brief: "搭场景", nodeIds: [], status: "done", startedAt: 10, finishedAt: 30, toolCalls: [], text: "好", changedNodeIds: [] }
          ]
        }
      }
    ])
    expect(conversation.messages[conversation.messages.length - 1]).toMatchObject({ id: "a1", subtasks: [{ id: "sub_1", status: "done", finishedAt: 30 }] })
  })
})
