import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import {
  AGENT_CANVAS_CHANGE_EVENT,
  AGENT_SKILL_LOADED_EVENT,
  AGENT_SUBTASK_EVENT,
  AGENT_SUBTASK_UPDATE_EVENT,
  AGENT_USER_MESSAGE_EVENT,
  AGENT_REASONING_TEXT_LIMIT,
  AGENT_TOOL_VIEW_TEXT_LIMIT,
  AgentEventType,
  type AgentCanvasChangeMessage,
  type AgentSkillLoadedMessage,
  type AgentChatMessage,
  type AgentStreamEvent,
  type AgentSubtaskStatus,
  type AgentSubtaskUpdate,
  type AgentSubtaskView,
  type AgentToolCallMetadata,
  type AgentToolCallView,
  type AgentUsageView,
} from '@shadecn/shared/agent'
import { createId } from '@shadecn/shared/id'
import type { RunnerEventBody } from './protocol.ts'
import { LOAD_SKILL_TOOL_NAME, REQUEST_CONFIRMATION_TOOL_NAME } from './skills/registry.ts'

/**
 * pi 的 `AgentEvent` → 线上事件（AG-UI 子集，形状见 `@shadecn/shared/agent`）。
 *
 * **整个映射只在这一个文件里**：路由只管把这里吐出来的对象逐帧写成 `data: <JSON>\n\n`，
 * 不认识任何一种事件。将来换协议（或者 AG-UI 加字段）只改这里。
 *
 * 二期起 pi 跑在沙箱里的 runner 中（docs/22 §4），**映射仍在服务端这里做**；docs/22 §4.3 第 3 步起**喂进来的事件也是服务端产生的**：
 * 编排层（`session.ts` 的 `display`）按 pi 事件的同名同形（{@link ServerAgentEvent}）合成 —— 文字增量来自服务端自己调模型的流，
 * 回复定稿来自服务端的结果，工具的开始 / 结束来自服务端那条回复 + 网关的执行记录 / 服务端拼的任务结果 / 服务端代算的拒绝。
 * runner 上报的事件不再拿来产生这里的任何内容（被攻破的 runner 不能让人看到、并且落库一段模型没说过的话）；第 7 版起线上也只剩工具的开始 / 结束。
 * 映射放在服务端，是因为 runner 随时可能被杀（中止 / 失权 / 超时）：收尾帧、落库的 assistant 消息
 * 都得由服务端补齐，映射状态必须在服务端。
 *
 * 顺便它也是「这一轮落定的 assistant 消息长什么样」的唯一来源 —— 对话记录里存的那条
 * （`message`）和线上发出去的事件是同一份状态一起推出来的，两边不会对不上：
 * 刷新后从 `GET` 读回来的消息，等于实时流里所有 TEXT_MESSAGE_CONTENT 拼起来的文字。
 *
 * 映射规则（与契约注释一致）：
 * - 同一轮 assistant 的多段文字共用一个 `messageId`（= 对话记录里那条 assistant 消息的 id），
 *   每段各自 START / CONTENT* / END。段落之间的分隔（`\n\n`）放进下一段第一帧 CONTENT 里，
 *   所以「拼起来的 delta」和「存下来的 text」逐字相同。空段不发（AG-UI 要求 delta 非空）。
 * - 工具：START（metadata 带给人看的那句话，status=running）→ ARGS（参数 JSON 一次发完）
 *   → END → RESULT（messageId 是结果自己的新 id；content 是回给模型的文本）。
 * - 思考（thinking，只有入口 agent 的）：每段 REASONING_MESSAGE_START / CONTENT* / END，进 assistant 消息的 `reasoning`
 *   （带 `position` = 开始时已有几条工具调用，界面据此排时间线）。整条消息合计到 {@link AGENT_REASONING_TEXT_LIMIT} 字为止，
 *   超出的不推也不存（补发缓冲和落库都带着它）。思考和文字互相关段：一段开始先关另一种没关的。
 *   被调用的 agent 的思考不显示（它的文字也不逐帧显示，同理）。
 * - 每段文字开始（TEXT_MESSAGE_START）带 `position`，消息的 `textSegments` 记每段在 `text` 里的起点和位置 —— 界面把工具调用之间的话排进时间线。
 * - 工具调用条目带 `input`（服务端那份参数的 JSON）和 `output`（回给模型的结果文本），各截到
 *   {@link AGENT_TOOL_VIEW_TEXT_LIMIT} 字，随条目落库 —— 给人展开查看；任务条目里的工具调用同样带。
 * - 收尾帧的 `result.usage` 是编排层在收尾那一刻交进来的这一轮用量（{@link RunEventMapper.finish}）。
 * - 画布改动通知（docs/20 §3.10.2）：CUSTOM `agent.canvas-change`，`value` 就是对话里存的那条
 *   `canvas-change` 消息。什么时候发由编排层定（跨轮差异紧跟用户消息回显；运行中的那种在它真正进入
 *   模型上下文时 —— 服务端把它插进入口 agent 的 transcript、随下一次模型请求发出的那一刻），这里只管形状。
 * - 技能加载（docs/23 §3.6）：`load_skill` **不作为工具调用条目出现**（不发 TOOL_CALL_*，也不进 assistant 消息的
 *   `toolCalls`）；网关加载成功时发 CUSTOM `agent.skill-loaded`，`value` 就是对话里存的那条 `skill-loaded` 消息。
 * - 工具调用的 id：线上的 `toolCallId` / `toolCalls[].id` 在一条 assistant 消息（一个任务条目）里唯一。上游复用调用 id
 *   （有的端点每次回复都从 `call_0` 起）时，后来的那条加后缀 `#2`、`#3`…；同一个原始 id 的 end 归到最近一次 start 的那一条。
 *   模型上下文、工具调用日志仍用原始 id（它们本来就按批对应）。
 * - 任务（docs/20 §3.10.11）：调用方的 `run_agent` 照常是一条工具调用；被调用的 agent 的事件（编排层按它的 agent id 归过来的）
 *   **不进**这条 assistant 消息的文字和 `toolCalls`，而是改它 `subtasks` 里对应的那一项：发起时一帧 CUSTOM `agent.subtask`
 *   （完整条目），之后每次变化一帧 CUSTOM `agent.subtask-update`（**只带变了的**：新的 / 变了的那条工具调用、新的回复、结束时的状态）——
 *   完整条目带着最长 8000 字的任务说明和全部工具调用，逐帧重复会让补发量随调用数成倍增长。落库的 `subtasks` 是完整条目。
 *   被调用的 agent 的文字增量不逐帧发：只在它的一条**有文字的**回复结束（message_end）时更新 `text` —— 所以 `text` 总是它最后一条有文字的回复
 *   （最后一步只调了工具、出错或被中止时也不会变成空），交回调用方的结果文字也取它（{@link RunEventMapper.subtaskReply}；
 *   喂进来的 message_end 是服务端调模型的定稿，runner 不报）。
 *   它的 `load_skill` / `request_confirmation` 不列进它的工具调用（状态和问题已经在条目上了）。
 *   **嵌套**（调用深度上限 > 1）：被调用的 agent 自己的 `run_agent` 是它条目里的一条工具调用，它发起的任务仍平铺进同一条消息的 `subtasks`，
 *   带 `parentId`（发起它的那个任务），`toolCallId` 换成父条目里那一条的显示 id —— 帧的形状、只发变化的规矩都不变。
 */

/**
 * 喂给映射器的事件：pi `AgentEvent` 里映射要读的那几种，同名同形、只留要读的字段 —— 编排层用服务端自己的东西合成
 * （文字增量 / 回复定稿来自服务端调模型的流和定稿，工具的开始 / 结束来自服务端那条回复和执行记录）。
 * 工具的开始 / 结束和 runner 上报的同一个形状（`protocol.ts` 的 `RunnerEventBody`）
 */
export type ServerAgentEvent =
  | {
      type: 'message_update'
      assistantMessageEvent:
        | { type: 'text_delta'; delta: string }
        | { type: 'text_end' }
        | { type: 'thinking_delta'; delta: string }
        | { type: 'thinking_end' }
    }
  | { type: 'message_end'; message: AgentMessage }
  | RunnerEventBody

/** 一轮怎么收的尾 */
export type RunOutcome =
  | { type: 'success' }
  | { type: 'cancelled'; reason?: string }
  /** Grant 到期（docs/22）。线上仍是 RUN_FINISHED + `cancelled`：前端契约不变，原因在 `result.error` */
  | { type: 'expired'; reason: string }
  | { type: 'error'; message: string; code?: string }

export interface RunEventMapperOptions {
  /** = flowId */
  threadId: string
  runId: string
  assistantMessageId: string
  /** 工具调用开始时给人看的那句话（结束时以工具自己 `details.summary` 为准） */
  describeTool: (name: string, args: unknown) => string
  now?: () => number
}

/** 一个任务条目里最多记多少条工具调用（落库带着它们；预算本来就全轮共用，到不了） */
const SUBTASK_TOOL_CALLS_LIMIT = 100

/** 任务条目里（给人看、随对话落库）留被调用的 agent 回复的多少字；交回调用方的另按 `taskReplyChars` 截 */
export const SUBTASK_TEXT_LIMIT = 8000

/** 任务条目开始时要的东西（服务端在 `/agent/task/start` 登记时给） */
export interface SubtaskStart {
  id: string
  /** 执行它的 agent 定义的名字 */
  agent: string
  /** 发起它的那个任务（调用方是被调用的 agent 时）；入口 agent 发起的不给 */
  parentId?: string
  /** 调用方那次 `run_agent` 的**原始** id（在调用方自己的工具调用里：入口 agent 的或父条目的） */
  toolCallId: string
  brief: string
  nodeIds: readonly string[]
  startedAt: number
}

/** 任务条目结束时（`/agent/task/finish`，服务端已改判过状态）。回复文字不在这里：条目上已经是它最后一条有文字的回复 */
export interface SubtaskEnd {
  status: Exclude<AgentSubtaskStatus, 'running'>
  question?: string | null
  error?: string | null
  changedNodeIds: readonly string[]
}

/** 发给前端的工具结果文本上限。`read_canvas` 的 JSON 可能很大，前端只拿它做展开查看 */
export const TOOL_RESULT_CONTENT_LIMIT = 8000

type AssistantChatMessage = Extract<AgentChatMessage, { role: 'assistant' }>
type UserChatMessage = Extract<AgentChatMessage, { role: 'user' }>

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function resultSummary(result: unknown): string | undefined {
  const summary = (result as { details?: { summary?: unknown } } | null)?.details?.summary
  return typeof summary === 'string' && summary ? summary : undefined
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断，共 ${text.length} 字）` : text
}

/** 工具调用条目上给人看的参数：JSON 缩进排版，截短 */
function argsText(args: unknown): string {
  let json: string
  try {
    json = JSON.stringify(args ?? {}, null, 2) ?? '{}'
  } catch {
    json = '{}'
  }
  return clip(json, AGENT_TOOL_VIEW_TEXT_LIMIT)
}

/** 一条消息 / 一个任务条目里工具调用的显示 id：没用过就是原始 id，用过了（上游复用 id）加 `#2`、`#3`… */
function uniqueCallId(raw: string, used: Set<string>): string {
  let id = raw
  for (let n = 2; used.has(id); n += 1) id = `${raw}#${n}`
  used.add(id)
  return id
}

/** assistant 消息里的文字部分拼起来（被调用的 agent 的一条回复） */
function assistantText(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

export interface RunEventMapper {
  /** RUN_STARTED + 回显用户消息 */
  start(userMessage: UserChatMessage): AgentStreamEvent[]
  /** 吃一个 pi 事件（编排层按同名同形合成的那份，docs/22 §4.3 第 3 步），吐出零到多个线上事件 */
  handle(event: AgentEvent | ServerAgentEvent): AgentStreamEvent[]
  /** 一条画布改动通知（先关掉没关的文字段：通知插在两段文字之间） */
  canvasChange(message: AgentCanvasChangeMessage): AgentStreamEvent[]
  /** 一次技能加载（同上，先关文字段） */
  skillLoaded(message: AgentSkillLoadedMessage): AgentStreamEvent[]
  /**
   * 一个任务开始了（调用方的 `run_agent` 登记成功）：条目进 `subtasks`，发一帧完整条目。
   * `start.toolCallId` 是调用方那次调用的**原始** id，这里换成它在调用方的工具调用列表（`toolCalls`，或父条目的 `toolCalls`）里那一条的显示 id
   */
  subtaskStart(start: SubtaskStart): AgentStreamEvent[]
  /** 一个被调用的 agent 的事件（同样是编排层合成的）→ 它那一项的变化帧（只带变了的；没变化就是空数组）；认不出的 id 忽略 */
  subtaskEvent(agentId: string, event: AgentEvent | ServerAgentEvent): AgentStreamEvent[]
  /** 一个任务结束了 */
  subtaskFinish(agentId: string, end: SubtaskEnd): AgentStreamEvent[]
  /** 这一轮的某个任务条目（只读用）；没有为 undefined */
  subtask(agentId: string): AgentSubtaskView | undefined
  /** 被调用的 agent 最后一条有文字的回复（服务端调模型的定稿里记的，没截短）；没有为空串 */
  subtaskReply(agentId: string): string
  /** 原始调用 id 最近一次对应的那条工具调用（调用方的；给了 `taskAgentId` 就是那个被调用的 agent 的）；没有为 undefined */
  toolCall(toolCallId: string, taskAgentId?: string): AgentToolCallView | undefined
  /**
   * 收尾：关掉没关的文字 / 思考段，还在跑的任务标成失败，再发 RUN_FINISHED / RUN_ERROR。
   * 给了 `usage` 就写进消息（RUN_FINISHED 的 `result` 和落库的那条都带着）
   */
  finish(outcome: RunOutcome, usage?: AgentUsageView): AgentStreamEvent[]
  /** 这一轮的 assistant 消息（随事件推进；`finish` 之后是最终态） */
  readonly message: AssistantChatMessage
  /** 模型自己报的错（`stopReason === 'error'` 那条 assistant 消息的 errorMessage） */
  readonly modelError: string | undefined
}

export function createRunEventMapper(options: RunEventMapperOptions): RunEventMapper {
  const { threadId, runId, assistantMessageId: messageId, describeTool } = options
  const now = options.now ?? Date.now

  const message: AssistantChatMessage = {
    id: messageId,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: now(),
  }
  /** 原始调用 id → 它最近一次 start 的那条工具调用（end 归到它） */
  const calls = new Map<string, AgentToolCallView>()
  /** `message.toolCalls` 里用过的显示 id */
  const callIds = new Set<string>()
  /**
   * 被调用的 agent id → 它的条目（就是 `message.subtasks` 里的那个对象）、它的工具调用（原始 id → 那一条）、
   * 条目里用过的显示 id、它最后一条有文字的回复（没截短）
   */
  const subtasks = new Map<
    string,
    { view: AgentSubtaskView; calls: Map<string, AgentToolCallView>; ids: Set<string>; reply: string }
  >()
  let textOpen = false
  let modelError: string | undefined
  /** 正在推的那段思考（没有 = 没在想） */
  let reasoningOpen: { id: string; view: { text: string; finishedAt?: number } } | null = null
  /** 这条消息里思考已经用了多少字（到上限就不再推） */
  let reasoningChars = 0
  let reasoningClipped = false

  function closeText(out: AgentStreamEvent[]) {
    closeReasoning(out)
    if (!textOpen) return
    textOpen = false
    out.push({ type: AgentEventType.TEXT_MESSAGE_END, messageId, timestamp: now() })
  }

  function closeReasoning(out: AgentStreamEvent[]) {
    if (!reasoningOpen) return
    reasoningOpen.view.finishedAt = now()
    out.push({ type: AgentEventType.REASONING_MESSAGE_END, messageId: reasoningOpen.id, timestamp: now() })
    reasoningOpen = null
  }

  function reasoning(delta: string, out: AgentStreamEvent[]) {
    if (!delta || reasoningClipped) return
    // 思考开始：先关没关的文字段（不经 closeText —— 它会把这段思考也关掉）
    if (textOpen) {
      textOpen = false
      out.push({ type: AgentEventType.TEXT_MESSAGE_END, messageId, timestamp: now() })
    }
    let chunk = delta
    if (reasoningChars + chunk.length > AGENT_REASONING_TEXT_LIMIT) {
      chunk = `${chunk.slice(0, Math.max(0, AGENT_REASONING_TEXT_LIMIT - reasoningChars))}…（思考内容过长，后面的不再显示）`
      reasoningClipped = true
    }
    reasoningChars += chunk.length
    if (!reasoningOpen) {
      const view = { id: createId('rsn'), text: '', position: message.toolCalls.length, startedAt: now() }
      message.reasoning ??= []
      message.reasoning.push(view)
      reasoningOpen = { id: view.id, view }
      out.push({
        type: AgentEventType.REASONING_MESSAGE_START,
        messageId: view.id,
        role: 'reasoning',
        parentMessageId: messageId,
        position: view.position,
        timestamp: now(),
      })
    }
    reasoningOpen.view.text += chunk
    out.push({ type: AgentEventType.REASONING_MESSAGE_CONTENT, messageId: reasoningOpen.id, delta: chunk, timestamp: now() })
  }

  function text(delta: string, out: AgentStreamEvent[]) {
    if (!delta) return
    closeReasoning(out)
    let chunk = delta
    if (!textOpen) {
      textOpen = true
      const position = message.toolCalls.length
      // 起点在拼上这一段（含分隔的空行）之前：前端按 START 那一刻的文字长度记，两边一致
      message.textSegments ??= []
      message.textSegments.push({ at: message.text.length, position })
      out.push({ type: AgentEventType.TEXT_MESSAGE_START, messageId, role: 'assistant', position, timestamp: now() })
      // 新的一段：和上一段之间空一行，分隔符算在这一段里，拼起来才和存下来的一致
      if (message.text) chunk = `\n\n${delta}`
    }
    message.text += chunk
    out.push({ type: AgentEventType.TEXT_MESSAGE_CONTENT, messageId, delta: chunk, timestamp: now() })
  }

  function metadata(call: AgentToolCallView): AgentToolCallMetadata {
    return {
      summary: call.summary,
      status: call.status,
      ...(call.error !== undefined ? { error: call.error } : {}),
      ...(call.input !== undefined ? { input: call.input } : {}),
      ...(call.output !== undefined ? { output: call.output } : {}),
    }
  }

  function subtaskFrame(view: AgentSubtaskView): AgentStreamEvent {
    // 拷一份：同 RUN_FINISHED 的 result（事件可能被异步序列化，之后条目还会变）
    return { type: AgentEventType.CUSTOM, name: AGENT_SUBTASK_EVENT, value: structuredClone(view), timestamp: now() }
  }

  /** 一次变化：只带变了的（同样拷一份） */
  function updateFrame(update: AgentSubtaskUpdate): AgentStreamEvent {
    return { type: AgentEventType.CUSTOM, name: AGENT_SUBTASK_UPDATE_EVENT, value: structuredClone(update), timestamp: now() }
  }

  /** 结束一个条目：还在转的工具调用一律算出错。返回这次变化（含被改成出错的那几条工具调用） */
  function settle(view: AgentSubtaskView, end: SubtaskEnd): AgentSubtaskUpdate {
    view.status = end.status
    view.finishedAt = now()
    view.changedNodeIds = [...end.changedNodeIds]
    if (end.question) view.question = end.question
    if (end.error) view.error = end.error
    const settled: AgentToolCallView[] = []
    for (const call of view.toolCalls) {
      if (call.status === 'running') {
        call.status = 'error'
        call.error = '未完成'
        settled.push(call)
      }
    }
    return {
      id: view.id,
      status: view.status,
      finishedAt: view.finishedAt,
      changedNodeIds: view.changedNodeIds,
      ...(view.question ? { question: view.question } : {}),
      ...(view.error ? { error: view.error } : {}),
      ...(settled.length > 0 ? { toolCalls: settled } : {}),
    }
  }

  return {
    get message() {
      return message
    },
    get modelError() {
      return modelError
    },

    start(userMessage) {
      return [
        { type: AgentEventType.RUN_STARTED, threadId, runId, timestamp: now() },
        {
          type: AgentEventType.CUSTOM,
          name: AGENT_USER_MESSAGE_EVENT,
          value: userMessage,
          timestamp: now(),
        },
      ]
    },

    canvasChange(change) {
      const out: AgentStreamEvent[] = []
      closeText(out)
      out.push({
        type: AgentEventType.CUSTOM,
        name: AGENT_CANVAS_CHANGE_EVENT,
        // 拷一份：同 RUN_FINISHED 的 result
        value: structuredClone(change),
        timestamp: now(),
      })
      return out
    },

    skillLoaded(loaded) {
      const out: AgentStreamEvent[] = []
      closeText(out)
      out.push({
        type: AgentEventType.CUSTOM,
        name: AGENT_SKILL_LOADED_EVENT,
        value: structuredClone(loaded),
        timestamp: now(),
      })
      return out
    },

    subtaskStart(start) {
      const callerCalls = start.parentId === undefined ? calls : subtasks.get(start.parentId)?.calls
      const view: AgentSubtaskView = {
        id: start.id,
        agent: start.agent,
        ...(start.parentId !== undefined ? { parentId: start.parentId } : {}),
        toolCallId: callerCalls?.get(start.toolCallId)?.id ?? start.toolCallId,
        brief: start.brief,
        nodeIds: [...start.nodeIds],
        status: 'running',
        startedAt: start.startedAt,
        toolCalls: [],
        text: '',
        changedNodeIds: [],
      }
      message.subtasks ??= []
      message.subtasks.push(view)
      subtasks.set(view.id, { view, calls: new Map(), ids: new Set(), reply: '' })
      return [subtaskFrame(view)]
    },

    subtaskEvent(agentId, event) {
      const entry = subtasks.get(agentId)
      if (!entry || entry.view.status !== 'running') return []
      const { view } = entry
      switch (event.type) {
        case 'message_end': {
          if (event.message.role !== 'assistant') return []
          // 只调了工具 / 出错 / 被中止的那条没有文字：不改，条目上留着上一条有文字的回复
          const text = assistantText(event.message)
          if (!text) return []
          entry.reply = text
          const shown = clip(text, SUBTASK_TEXT_LIMIT)
          if (shown === view.text) return []
          view.text = shown
          return [updateFrame({ id: view.id, text: shown })]
        }
        case 'tool_execution_start': {
          if (event.toolName === LOAD_SKILL_TOOL_NAME || event.toolName === REQUEST_CONFIRMATION_TOOL_NAME) return []
          if (view.toolCalls.length >= SUBTASK_TOOL_CALLS_LIMIT) {
            // 不列这一条：它的 end 也别归到同一个原始 id 以前的那条上
            entry.calls.delete(event.toolCallId)
            return []
          }
          let summary: string
          try {
            summary = describeTool(event.toolName, event.args)
          } catch {
            summary = event.toolName
          }
          const call: AgentToolCallView = {
            id: uniqueCallId(event.toolCallId, entry.ids),
            name: event.toolName,
            summary,
            status: 'running',
            input: argsText(event.args),
          }
          entry.calls.set(event.toolCallId, call)
          view.toolCalls.push(call)
          return [updateFrame({ id: view.id, toolCalls: [call] })]
        }
        case 'tool_execution_end': {
          const call = entry.calls.get(event.toolCallId)
          if (!call) return []
          if (event.isError) {
            call.status = 'error'
            call.error = clip(resultText(event.result) || '工具调用失败', 500)
          } else {
            call.status = 'done'
            call.summary = resultSummary(event.result) ?? call.summary
            const body = resultText(event.result)
            if (body) call.output = clip(body, AGENT_TOOL_VIEW_TEXT_LIMIT)
          }
          return [updateFrame({ id: view.id, toolCalls: [call] })]
        }
        default:
          return []
      }
    },

    subtaskFinish(agentId, end) {
      const entry = subtasks.get(agentId)
      if (!entry || entry.view.status !== 'running') return []
      return [updateFrame(settle(entry.view, end))]
    },

    subtask: (agentId) => subtasks.get(agentId)?.view,

    subtaskReply: (agentId) => subtasks.get(agentId)?.reply ?? '',

    toolCall: (toolCallId, taskAgentId) =>
      taskAgentId === undefined ? calls.get(toolCallId) : subtasks.get(taskAgentId)?.calls.get(toolCallId),

    handle(event) {
      const out: AgentStreamEvent[] = []
      // load_skill 只显示成「已加载：…」那一行（skillLoaded），不是普通的工具调用条目
      if ((event.type === 'tool_execution_start' || event.type === 'tool_execution_end') && event.toolName === LOAD_SKILL_TOOL_NAME) {
        return out
      }
      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent
          if (inner.type === 'text_delta') text(inner.delta, out)
          else if (inner.type === 'text_end') closeText(out)
          else if (inner.type === 'thinking_delta') reasoning(inner.delta, out)
          else if (inner.type === 'thinking_end') closeReasoning(out)
          break
        }
        case 'message_end': {
          if (event.message.role !== 'assistant') break
          closeText(out)
          if (event.message.stopReason === 'error') {
            modelError = event.message.errorMessage || '模型调用失败'
          }
          break
        }
        case 'tool_execution_start': {
          closeText(out)
          let summary: string
          try {
            summary = describeTool(event.toolName, event.args)
          } catch {
            summary = event.toolName
          }
          const call: AgentToolCallView = {
            id: uniqueCallId(event.toolCallId, callIds),
            name: event.toolName,
            summary,
            status: 'running',
            input: argsText(event.args),
          }
          calls.set(event.toolCallId, call)
          message.toolCalls.push(call)
          out.push(
            {
              type: AgentEventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: messageId,
              metadata: metadata(call),
              timestamp: now(),
            },
            {
              type: AgentEventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: JSON.stringify(event.args ?? {}),
              timestamp: now(),
            },
            { type: AgentEventType.TOOL_CALL_END, toolCallId: call.id, timestamp: now() },
          )
          break
        }
        case 'tool_execution_end': {
          let call = calls.get(event.toolCallId)
          if (!call) {
            // 理论上不会：没有 start 的 end。补一条，别让结果凭空丢掉
            call = { id: uniqueCallId(event.toolCallId, callIds), name: event.toolName, summary: event.toolName, status: 'running' }
            calls.set(event.toolCallId, call)
            message.toolCalls.push(call)
          }
          const body = resultText(event.result)
          if (event.isError) {
            call.status = 'error'
            call.error = body || '工具调用失败'
          } else {
            call.status = 'done'
            call.summary = resultSummary(event.result) ?? call.summary
            if (body) call.output = clip(body, AGENT_TOOL_VIEW_TEXT_LIMIT)
          }
          out.push({
            type: AgentEventType.TOOL_CALL_RESULT,
            messageId: createId('tr'),
            toolCallId: call.id,
            content: clip(body, TOOL_RESULT_CONTENT_LIMIT),
            role: 'tool',
            metadata: metadata(call),
            timestamp: now(),
          })
          break
        }
        default:
          break
      }
      return out
    },

    finish(outcome, usage) {
      const out: AgentStreamEvent[] = []
      closeText(out)
      if (usage) message.usage = { ...usage }
      // 还在跑的任务（这一轮被停 / 出错打断的）：标成失败，各发一帧（RUN_ERROR 不带落定的消息，前端靠这一帧收住它）
      for (const { view } of subtasks.values()) {
        if (view.status !== 'running') continue
        const update = settle(view, {
          status: 'failed',
          error: outcome.type === 'cancelled' || outcome.type === 'expired' ? (outcome.reason ?? '已中止') : '这一轮结束时它还没做完',
          changedNodeIds: view.changedNodeIds,
        })
        out.push(updateFrame(update))
      }
      // 一轮收尾时还挂着的工具调用（中止 / 出错打断的）：别让界面一直转圈
      for (const call of message.toolCalls) {
        if (call.status === 'running') {
          call.status = 'error'
          call.error = outcome.type === 'cancelled' || outcome.type === 'expired' ? '已中止' : '未完成'
        }
      }

      if (outcome.type === 'error') {
        message.error = outcome.message
        out.push({
          type: AgentEventType.RUN_ERROR,
          message: outcome.message,
          ...(outcome.code ? { code: outcome.code } : {}),
          timestamp: now(),
        })
        return out
      }

      if (outcome.type === 'cancelled') message.error = outcome.reason ?? '已中止'
      if (outcome.type === 'expired') message.error = outcome.reason
      out.push({
        type: AgentEventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: outcome.type === 'success' ? 'success' : 'cancelled' },
        // 拷一份：事件可能被异步序列化，别让它和之后对 message 的改动共享引用
        result: structuredClone(message),
        timestamp: now(),
      })
      return out
    },
  }
}
