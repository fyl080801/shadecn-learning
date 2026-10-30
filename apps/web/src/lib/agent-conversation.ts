import {
  AGENT_CANVAS_CHANGE_EVENT,
  AGENT_SKILL_LOADED_EVENT,
  AGENT_SUBTASK_EVENT,
  AGENT_SUBTASK_UPDATE_EVENT,
  AGENT_USER_MESSAGE_EVENT,
  AgentEventType,
  applyAgentSubtaskUpdate,
  parseAgentSubtask,
  parseAgentSubtaskUpdate,
  type AgentChatMessage,
  type AgentStreamEvent,
  type AgentToolCallMetadata,
  type AgentToolCallView
} from "@shadecn/shared/agent"

/**
 * 画布 Agent 一轮事件流 → 对话记录的折叠 —— **纯逻辑，没有网络、没有组件**。
 *
 * 事件是 AG-UI 的子集（`@shadecn/shared/agent` 注释里有完整顺序）。这里只回答一件事：
 * 「收到这个事件之后，对话列表长什么样」。拆出来是为了能被真的测到 ——
 * 跨段拼文字、工具状态翻转、落定消息覆盖本地拼出来的那份，这些全是
 * 「坏了也不报错、只是界面看着不对」的那一类。
 *
 * 状态对象是**就地修改**的：调用方把它包进 `reactive()`，Vue 自己追踪变化，
 * 不必每个 delta 复制一遍整个数组（一轮可能有几百个 TEXT_MESSAGE_CONTENT）。
 */

type AssistantMessage = Extract<AgentChatMessage, { role: "assistant" }>
type UserMessage = Extract<AgentChatMessage, { role: "user" }>

export interface AgentConversation {
  messages: AgentChatMessage[]
  /** 本轮的 runId（RUN_STARTED 给）；没有在跑的一轮时为 null */
  runId: string | null
  /** 本地乐观插入的那条用户消息的 id —— 服务端回显后换成服务端的 id */
  userMessageId: string | null
  /** 本轮 assistant 消息的 id（文字和工具调用都挂在它上面） */
  assistantId: string | null
  /** 本轮已经收到 RUN_FINISHED / RUN_ERROR */
  finished: boolean
}

export function emptyConversation(messages: AgentChatMessage[] = []): AgentConversation {
  return { messages, runId: null, userMessageId: null, assistantId: null, finished: false }
}

/** 一轮中途断了、没等到收尾事件时，给 assistant 消息挂的说明 */
export const STREAM_INTERRUPTED_TEXT = "连接中断，这一轮的结果以画布上的实际内容为准"

/** 以「已中止」收尾、而服务端没写原因时的说明 */
export const RUN_CANCELLED_TEXT = "已中止"

/**
 * 开始新的一轮：把用户刚输入的那条先放进列表（乐观插入），清掉上一轮的游标。
 * 服务端的 `agent.user-message` 回显到达后会用带正式 id 的那条替换它。
 */
export function beginTurn(conversation: AgentConversation, message: UserMessage) {
  conversation.messages.push(message)
  conversation.runId = null
  conversation.userMessageId = message.id
  conversation.assistantId = null
  conversation.finished = false
}

/**
 * 接回一轮正在跑的（重新打开画布、换回这张画布、另一个标签页发起的）。
 *
 * 对话里已经摆着服务端的 `latest.messages` —— 这一轮的**用户消息**在调模型之前就落了库，
 * 所以它就是最后一条；assistant 那条要等这一轮结束才落库，还没有。接下来补发的事件
 * 从 RUN_STARTED 起和发起时那条流一模一样，其中 CUSTOM `agent.user-message` 回显的
 * 正是那条用户消息：把游标指过去，它就按 id **替换**而不是再插一条。
 */
export function resumeTurn(conversation: AgentConversation, runId: string) {
  const last = conversation.messages[conversation.messages.length - 1]
  conversation.runId = runId
  conversation.userMessageId = last?.role === "user" ? last.id : null
  conversation.assistantId = null
  conversation.finished = false
}

/** 这一轮根本没开始（请求被拒）：把乐观插入的那条撤回来 */
export function rollbackTurn(conversation: AgentConversation) {
  const id = conversation.userMessageId
  if (id) conversation.messages = conversation.messages.filter((message) => message.id !== id)
  conversation.userMessageId = null
  conversation.assistantId = null
  conversation.runId = null
  conversation.finished = true
}

function findAssistant(conversation: AgentConversation, id: string | null) {
  if (!id) return null
  const found = conversation.messages.find((message) => message.id === id)
  return found && found.role === "assistant" ? found : null
}

/** 找到（或新建）本轮的 assistant 消息。同一轮几段文字共用一个 messageId，所以按 id 认 */
function ensureAssistant(conversation: AgentConversation, id: string): AssistantMessage {
  const existing = findAssistant(conversation, id)
  if (existing) {
    conversation.assistantId = id
    return existing
  }
  const created: AssistantMessage = {
    id,
    role: "assistant",
    text: "",
    toolCalls: [],
    createdAt: Date.now()
  }
  conversation.messages.push(created)
  conversation.assistantId = id
  // 拿 reactive 包过的那份回去 —— 直接改 `created` 改的是原始对象，界面不会动
  return conversation.messages[conversation.messages.length - 1] as AssistantMessage
}

function applyToolMetadata(call: AgentToolCallView, metadata: AgentToolCallMetadata | undefined) {
  if (!metadata) return
  if (typeof metadata.summary === "string" && metadata.summary) call.summary = metadata.summary
  if (metadata.status === "running" || metadata.status === "done" || metadata.status === "error") {
    call.status = metadata.status
  }
  if (metadata.error) call.error = metadata.error
}

/** 工具调用按 id 找；先看本轮那条 assistant，找不到再全表找（容错） */
function findToolCall(conversation: AgentConversation, toolCallId: string) {
  const current = findAssistant(conversation, conversation.assistantId)
  const inCurrent = current?.toolCalls.find((call) => call.id === toolCallId)
  if (inCurrent) return inCurrent
  for (const message of conversation.messages) {
    if (message.role !== "assistant") continue
    const call = message.toolCalls.find((item) => item.id === toolCallId)
    if (call) return call
  }
  return null
}

/** 还挂着「运行中」的工具调用 / 子任务在一轮结束时一律算出错 —— 留着会是一个永远在转的圈 */
function settleRunningTools(message: AssistantMessage | null) {
  for (const call of message?.toolCalls ?? []) {
    if (call.status === "running") call.status = "error"
  }
  for (const task of message?.subtasks ?? []) {
    if (task.status !== "running") continue
    task.status = "failed"
    for (const call of task.toolCalls) if (call.status === "running") call.status = "error"
  }
}

/**
 * 子任务条目（docs/20 §3.10.11）：派发时那一帧是这一项的完整样子 —— 解析过（畸形的丢掉）再按 id 整条替换进它所属的 assistant 消息。
 * 属于哪条消息：本轮那条；还没有（理论上不会：派发之前一定有那次 delegate_task 的 TOOL_CALL_START）就按 toolCallId 找。
 */
function applySubtask(conversation: AgentConversation, value: unknown) {
  const task = parseAgentSubtask(value)
  if (!task) return
  const owner =
    findAssistant(conversation, conversation.assistantId) ??
    conversation.messages.find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.toolCalls.some((call) => call.id === task.toolCallId)
    ) ??
    null
  if (!owner) return
  const list = (owner.subtasks ??= [])
  const index = list.findIndex((item) => item.id === task.id)
  if (index >= 0) list.splice(index, 1, task)
  else list.push(task)
}

/**
 * 子任务条目的一次变化（之后的每一帧只带变了的）：解析过再合并进同 id 的那一项（先找本轮那条 assistant，再全表找）。
 * 还没有那一项（没收到派发那一帧）就丢掉 —— 补发总是从 RUN_STARTED 起，正常不会发生
 */
function applySubtaskUpdate(conversation: AgentConversation, value: unknown) {
  const update = parseAgentSubtaskUpdate(value)
  if (!update) return
  const current = findAssistant(conversation, conversation.assistantId)
  const owners = current ? [current, ...conversation.messages] : conversation.messages
  for (const message of owners) {
    if (message.role !== "assistant" || !message.subtasks) continue
    const index = message.subtasks.findIndex((item) => item.id === update.id)
    if (index < 0) continue
    message.subtasks.splice(index, 1, applyAgentSubtaskUpdate(message.subtasks[index]!, update))
    return
  }
}

/** 用服务端落定的那条替换本地拼出来的；本地没有就追加 */
function replaceMessage(conversation: AgentConversation, id: string | null, next: AgentChatMessage) {
  const index = conversation.messages.findIndex(
    (message) => message.id === next.id || (id !== null && message.id === id)
  )
  if (index >= 0) conversation.messages.splice(index, 1, next)
  else conversation.messages.push(next)
}

/** 收到一个事件。认不出的事件类型直接忽略 —— 服务端以后多发一种，不该把这边带崩 */
export function applyAgentEvent(conversation: AgentConversation, event: AgentStreamEvent) {
  switch (event.type) {
    case AgentEventType.RUN_STARTED:
      conversation.runId = event.runId
      return

    case AgentEventType.CUSTOM: {
      if (!event.value) return
      if (event.name === AGENT_CANVAS_CHANGE_EVENT || event.name === AGENT_SKILL_LOADED_EVENT) {
        // 画布改动通知（docs/20 §3.10.2）/ 技能加载（docs/23 §3.6）：追加到末尾，和服务端落库的顺序一致；
        // 按 id 去重（补发 / 重复帧）。名字和 role 对不上的不收
        const role = event.name === AGENT_CANVAS_CHANGE_EVENT ? "canvas-change" : "skill-loaded"
        if (event.value.role !== role) return
        if (!conversation.messages.some((message) => message.id === event.value.id)) {
          conversation.messages.push(event.value)
        }
        return
      }
      if (event.name === AGENT_SUBTASK_EVENT) {
        applySubtask(conversation, event.value)
        return
      }
      if (event.name === AGENT_SUBTASK_UPDATE_EVENT) {
        applySubtaskUpdate(conversation, event.value)
        return
      }
      if (event.name !== AGENT_USER_MESSAGE_EVENT) return
      replaceMessage(conversation, conversation.userMessageId, event.value)
      conversation.userMessageId = event.value.id
      return
    }

    case AgentEventType.TEXT_MESSAGE_START:
      ensureAssistant(conversation, event.messageId)
      return

    case AgentEventType.TEXT_MESSAGE_CONTENT:
      ensureAssistant(conversation, event.messageId).text += event.delta ?? ""
      return

    case AgentEventType.TOOL_CALL_START: {
      const message = ensureAssistant(
        conversation,
        event.parentMessageId || conversation.assistantId || `local-${event.toolCallId}`
      )
      if (!message.toolCalls.some((item) => item.id === event.toolCallId)) {
        message.toolCalls.push({
          id: event.toolCallId,
          name: event.toolCallName,
          summary: event.toolCallName,
          status: "running"
        })
      }
      // 从数组里再取一次：拿到的是 reactive 包过的那份，改它界面才会动
      const call = message.toolCalls.find((item) => item.id === event.toolCallId)
      if (call) applyToolMetadata(call, event.metadata)
      return
    }

    case AgentEventType.TOOL_CALL_RESULT: {
      const call = findToolCall(conversation, event.toolCallId)
      if (!call) return
      applyToolMetadata(call, event.metadata)
      // 结果到了还说「运行中」是不可能的状态：没写就当成功
      if (call.status === "running") call.status = "done"
      return
    }

    case AgentEventType.RUN_FINISHED: {
      const result = event.result
      if (result && result.role === "assistant") {
        const settled: AssistantMessage = { ...result, toolCalls: [...(result.toolCalls ?? [])] }
        // 落定消息里的子任务同样防御着读（只留认得出的）
        if (result.subtasks !== undefined) {
          const subtasks = Array.isArray(result.subtasks) ? result.subtasks.flatMap((item) => parseAgentSubtask(item) ?? []) : []
          if (subtasks.length > 0) settled.subtasks = subtasks
          else delete settled.subtasks
        }
        if (event.outcome?.type === "cancelled" && !settled.error) settled.error = RUN_CANCELLED_TEXT
        replaceMessage(conversation, conversation.assistantId, settled)
        conversation.assistantId = settled.id
      } else {
        const current = findAssistant(conversation, conversation.assistantId)
        settleRunningTools(current)
        if (current && event.outcome?.type === "cancelled" && !current.error) {
          current.error = RUN_CANCELLED_TEXT
        }
      }
      conversation.finished = true
      return
    }

    case AgentEventType.RUN_ERROR: {
      const reason = event.message || "这一轮运行失败"
      const current = findAssistant(conversation, conversation.assistantId)
      if (current) {
        current.error = reason
        settleRunningTools(current)
      } else {
        // 还没说一个字就失败了：也得有一条消息把原因摆出来，不然用户只看到自己那条孤零零挂着
        const placeholder = ensureAssistant(conversation, `local-error-${Date.now()}`)
        placeholder.error = reason
      }
      conversation.finished = true
      return
    }

    default:
      // TEXT_MESSAGE_END / TOOL_CALL_ARGS / TOOL_CALL_END：界面上没有可对应的变化
      return
  }
}

/** 流结束了却没等到 RUN_FINISHED / RUN_ERROR（掉线、代理掐断）：把这一轮标成中断 */
export function interruptTurn(conversation: AgentConversation) {
  if (conversation.finished) return
  const current = findAssistant(conversation, conversation.assistantId)
  if (current) {
    if (!current.error) current.error = STREAM_INTERRUPTED_TEXT
    settleRunningTools(current)
  } else {
    ensureAssistant(conversation, `local-error-${Date.now()}`).error = STREAM_INTERRUPTED_TEXT
  }
  conversation.finished = true
}
