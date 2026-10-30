import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createInitialSystemMessage,
  getCurrentTools,
  getToolStateChanges,
  normalizeContext,
  toToolDeclaration,
  validateToolArguments,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { withoutImages } from './media.ts'
import { REQUEST_CONFIRMATION_ALONE_REASON, REQUEST_CONFIRMATION_TOOL_NAME } from './skills/index.ts'

/**
 * 服务端维护的**权威 transcript**（docs/22 §4.3 第 2 步，问题 C）：每个 agent 一份，模型请求只用它，落库的模型上下文也取它。
 * runner 送来的 `context.messages` 一律不看（它可以伪造工具结果、改写用户原话、删掉系统提示里的防注入说明）。
 *
 * 每一段都有服务端自己的来源（谁往这里写见 `session.ts`）：
 *
 * - 开头的 system 消息：服务端的系统提示 + 这个 agent 一开始的工具（{@link createTranscript}，pi-ai 的 `createInitialSystemMessage`）；
 * - 之前几轮：库里的 `llmMessages`（父 agent；子 agent 没有）；这一轮的用户消息：服务端拼的提示词；
 * - assistant：服务端自己调模型的结果（{@link recordReply}，`model-stream.ts` 定稿：调用 id 已补齐、`partialJson` / `partialArgs` 已去掉）；
 * - 工具结果：在这个 agent 的下一次请求时按调用顺序补齐（{@link closeBatch}）—— 网关执行 / 拒绝的（含工具调用上限、`load_skill` 没单独调用，
 *   第 7 版起由网关在调用到达时判）取网关回给 runner 的那一份，`delegate_task` 取服务端拼的子任务结果，
 *   runner 执行的工具（`execution: 'runner'`、`request_confirmation`）是**唯一**取 runner 上报的，
 *   pi 在 runner 里就地拦下、到不了网关的那几种由服务端按 pi 的同一套规则代算（{@link recordReply} 里的预判），都不是 →「这次调用没有执行」；
 * - `load_skill` 之后的 `toolsAdded` system 消息：服务端在那一批工具结果之后自己插（{@link declareTools}，同 pi 的 `declareToolChanges` 的位置）；
 * - 别人改动的通知：父 agent 的下一次请求时由服务端追加（{@link appendUserText}）。
 *
 * runner 里 pi 的 transcript 和这一份可以不同（通知、代算的拒绝文字它不知道），但两边看到的回复是同一条、网关回的结果是同一份，
 * 所以 runner 照常执行工具、照常请求下一步。
 */

/** 一次工具调用的结果（= pi 的工具结果消息里的那几项） */
export interface ToolResultRecord {
  content: (TextContent | ImageContent)[]
  details: unknown
  isError: boolean
}

/** 工具表里的一项：工具定义 + 在哪执行（runner 执行的工具结果取 runner 上报的） */
export interface TranscriptTool extends Tool {
  execution?: 'gateway' | 'runner'
}

/** 最近一条回复里的一次调用 */
export interface TranscriptCall {
  /** 服务端那条回复里的调用（名字、参数以它为准，runner 送来的只用来核对） */
  readonly call: ToolCall
  /**
   * 服务端预判这次调用不会执行（pi 在 runner 里就地拦下、到不了网关的那些）时给模型的那句话；null = 看执行记录。
   * 顺序同 pi + runner：输出被截断（`length`）→ 参数过长被掐断 → 工具不存在 → 参数过不了 schema → `request_confirmation` 没单独调用。
   * 工具调用上限、`load_skill` 没单独调用不在这里：网关在调用到达时判（session.ts 的 `executeBound`），结果就是执行记录
   */
  readonly refused: string | null
  /** 校验过的参数（pi-ai 的 `validateToolArguments`，和 runner 那边同一个函数、同一份 schema）；被预判拒绝的为 null */
  readonly args: unknown
  /** runner 执行的工具（结果取 runner 上报的，`delegate_task` 除外：它取服务端拼的子任务结果） */
  readonly local: boolean
  /** 网关已经开始执行它（同一次调用只执行一次） */
  claimed: boolean
  /** 执行记录（网关回给 runner 的、子任务结果、runner 上报的）；还没有为 null */
  result: ToolResultRecord | null
}

export interface AgentTranscript {
  /** 发给上游的全部消息（含 system 消息） */
  readonly messages: Message[]
  /** 这一轮的第一条消息（用户消息）的下标：落库只取这之后的 */
  readonly start: number
  /** 还能不能再请求模型：刚开始，或最近一条回复调了工具。最终回复、出错、中止之后为 false */
  open: boolean
  /** 最近一条回复里的调用（按调用顺序）；补齐结果之后为 null */
  pending: Map<string, TranscriptCall> | null
  /** 最近一次请求声明给模型的工具：预判那条回复里的调用用 */
  offered: Map<string, TranscriptTool>
}

/** runner 没执行、服务端也没预判出原因的调用（docs/22 §4.3「都不是」） */
export const TOOL_NOT_EXECUTED = '这次调用没有执行'

/**
 * 结果未知：这一轮被停在这次调用完成之前（被杀时最后一批缺的结果），或网关已经开始执行、结果却没赶上下一次请求。
 * 画布语义的那句话（需要时重读画布），落库的上下文与下一轮实际发给模型的是同一份（`completeToolResults` 也用它）
 */
export const TOOL_INTERRUPTED = '这一轮在这次工具调用完成之前被停止，结果未知；需要时请重新读取画布确认'

/** 这次 `/canvas/tool` 对不上模型最近一条回复里还没有结果的调用 */
export const TOOL_CALL_UNBOUND = '这次工具调用对不上模型最近一条回复里还没有结果的调用，没有执行'
export const TOOL_CALL_NAME_MISMATCH = '工具名和模型回复里的那次调用不一致，没有执行'
export const TOOL_CALL_ARGS_MISMATCH = '参数和模型回复里的那次调用不一致，没有执行'

/** pi 对输出被截断（`stopReason: 'length'`）的回复里每个调用给的结果（`failToolCallsFromTruncatedMessage`，pi-agent-core 1.4.0 原文） */
const truncatedCallText = (name: string) =>
  `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`

/** pi 找不到工具时的结果（`prepareToolCall`，原文） */
const toolNotFoundText = (name: string) => `Tool ${name} not found`

/**
 * 「必须单独调用」的 runner 工具：`request_confirmation` 在 runner 里执行、到不了网关，只能由 runner 的 `beforeToolCall` 拦下；
 * 规则只看这条回复本身（确定的），所以服务端在这里按同一条规则算，两边不会不一致。`load_skill` 是网关工具，由网关判
 */
const ALONE: Record<string, string> = {
  [REQUEST_CONFIRMATION_TOOL_NAME]: REQUEST_CONFIRMATION_ALONE_REASON,
}

const errorRecord = (text: string): ToolResultRecord => ({ content: [{ type: 'text', text }], details: {}, isError: true })

/** 一个 agent 的 transcript：开头的 system 消息（系统提示 + 工具表，同 pi `Agent` 构造时补的那条）+ 之前几轮 + 这一轮的用户消息 */
export function createTranscript(systemPrompt: string, tools: readonly TranscriptTool[], history: readonly AgentMessage[], prompt: string): AgentTranscript {
  const initial = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration))
  // 库里的上下文只该有这三种（system 从不落库）；别的一律不进请求
  const previous = history.filter(
    (message): message is Message => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
  )
  const messages: Message[] = [...(initial ? [initial] : []), ...previous]
  const start = messages.length
  messages.push(userMessage(prompt))
  return { messages, start, open: true, pending: null, offered: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** 同 pi 的 `prompt(string)`：一个文字块 */
function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

/** 服务端插的用户消息（别人改动的通知） */
export function appendUserText(transcript: AgentTranscript, text: string) {
  transcript.messages.push(userMessage(text))
}

/** 这次请求发给上游的上下文（一份快照：之后追加的不影响在途的这次） */
export function requestContext(transcript: AgentTranscript): TranscriptContext {
  return normalizeContext({ messages: [...transcript.messages] })
}

/**
 * 服务端调模型拿到一条回复：记进 transcript，并预判每个调用会不会被 pi 在 runner 里就地拦下（pi 的检查顺序：
 * `length` 截断 → 工具不存在 → `validateToolArguments` → runner 的 `beforeToolCall` 里唯一剩下的确定规则：`request_confirmation` 单独调用）。
 * `cut` 是参数过长被服务端掐断的调用（id → 给模型的话）。出错 / 中止 / 没有调用 → 这个 agent 不能再请求（pi 的循环到此为止）。
 * 工具调用上限不在这里预判（第 7 版起）：网关执行的在调用到达时由网关计数，runner 执行的在它上报开始时计（session.ts）。
 */
export function recordReply(transcript: AgentTranscript, message: AssistantMessage, cut: ReadonlyMap<string, string>) {
  transcript.messages.push(message)
  transcript.pending = null
  const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall')
  if (message.stopReason === 'error' || message.stopReason === 'aborted' || calls.length === 0) {
    transcript.open = false
    return
  }
  transcript.open = true
  const pending = new Map<string, TranscriptCall>()
  for (const call of calls) {
    const tool = transcript.offered.get(call.name)
    let refused: string | null = null
    let args: unknown = null
    if (message.stopReason === 'length') refused = truncatedCallText(call.name)
    else if (cut.has(call.id)) refused = cut.get(call.id)!
    else if (!tool) refused = toolNotFoundText(call.name)
    else {
      try {
        args = validateToolArguments(tool, call)
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err)
      }
      const alone = ALONE[call.name]
      if (refused === null && alone && calls.some((other) => other.name !== call.name)) refused = alone
      if (refused !== null) args = null
    }
    // 上游重复的调用 id 已经在 model-stream.ts 换掉了；万一还撞，后一个按「没有执行」处理（不覆盖前一个）
    if (pending.has(call.id)) continue
    pending.set(call.id, {
      call,
      refused,
      args,
      local: tool?.execution === 'runner',
      claimed: false,
      result: null,
    })
  }
  transcript.pending = pending
}

/**
 * 把最近一条回复的调用的结果按调用顺序补进 transcript（pi 的结果消息也是按调用顺序，并行批同样）：
 * 预判的拒绝 › 执行记录 › 没有记录 —— 下一次请求时（`request`）是「没有执行」（网关已开始执行却没等到结果的是「结果未知」），
 * 这一轮收尾时（`final`，被杀在半路）一律「结果未知」。
 */
export function closeBatch(transcript: AgentTranscript, mode: 'request' | 'final') {
  const pending = transcript.pending
  if (!pending) return
  transcript.pending = null
  const now = Date.now()
  for (const entry of pending.values()) {
    const record = batchResult(entry, mode)
    const message: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: entry.call.id,
      toolName: entry.call.name,
      content: record.content,
      details: record.details as ToolResultMessage['details'],
      isError: record.isError,
      timestamp: now,
    }
    transcript.messages.push(message)
  }
}

/**
 * 一次调用此刻在 transcript 里的结果（{@link closeBatch} 补进去的就是它）：预判的拒绝 › 执行记录 › 没有记录
 * （`request`：「没有执行」，网关已开始执行的是「结果未知」；`final`：一律「结果未知」）。
 * 界面上补显示这批调用的结束时用同一份（docs/22 §4.3 第 3 步：人看到的和模型看到的是同一句话）
 */
export function batchResult(entry: TranscriptCall, mode: 'request' | 'final'): ToolResultRecord {
  if (entry.refused !== null) return errorRecord(entry.refused)
  return entry.result ?? errorRecord(mode === 'request' && !entry.claimed ? TOOL_NOT_EXECUTED : TOOL_INTERRUPTED)
}

/**
 * 一批工具结果之后、下一次请求之前：这个 agent 现在的工具表和已经声明给模型的不一样（`load_skill` 加载了新技能）→
 * 追加一条带 `toolsAdded` / `toolsRemoved` 的 system 消息（pi 的 `declareToolChanges` 的做法与位置：排在这一批的结果之后、
 * 追加的用户消息之前）。它只在这一轮的内存里，落库时去掉（同 pi 的 system 消息从不落库）。
 */
export function declareTools(transcript: AgentTranscript, tools: readonly TranscriptTool[]) {
  const changes = getToolStateChanges(getCurrentTools(transcript.messages), tools.map(toToolDeclaration))
  if (changes.toolsAdded.length > 0 || changes.toolsRemoved.length > 0) {
    transcript.messages.push({
      role: 'system',
      content: '',
      ...(changes.toolsAdded.length > 0 ? { toolsAdded: changes.toolsAdded } : {}),
      ...(changes.toolsRemoved.length > 0 ? { toolsRemoved: changes.toolsRemoved } : {}),
      timestamp: Date.now(),
    })
  }
  transcript.offered = new Map(tools.map((tool) => [tool.name, tool]))
}

export type BindResult = { ok: true; entry: TranscriptCall } | { ok: false; message: string }

/** 对象按键排序后的 JSON：比较两份参数用（键的顺序不算差别） */
function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      )
    }
    return input
  }
  // 先过一遍 JSON：undefined 字段、Date 之类和线上那份一样
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}

/**
 * `/canvas/tool` 必须对得上**这个 agent 最近一条回复里还没有结果**的那次调用（id 相同、名字相同、参数和服务端校验过的那份相同），
 * 执行用服务端那份参数。预判会被拒绝的（runner 本该拦下）回预判的那句话；对上了就记成「开始执行」（同一次调用只执行一次）。
 */
export function bindCall(transcript: AgentTranscript, toolCallId: string, name: string, args: unknown): BindResult {
  const entry = transcript.pending?.get(toolCallId)
  if (!entry || entry.claimed || entry.result !== null) return { ok: false, message: TOOL_CALL_UNBOUND }
  if (entry.call.name !== name) return { ok: false, message: TOOL_CALL_NAME_MISMATCH }
  if (entry.refused !== null) return { ok: false, message: entry.refused }
  if (canonical(entry.args) !== canonical(args)) return { ok: false, message: TOOL_CALL_ARGS_MISMATCH }
  entry.claimed = true
  return { ok: true, entry }
}

/** 网关回给 runner 的那份 → 执行记录（runner 把错误原样抛给 pi：一个文字块、`details` 为空） */
export function gatewayResultRecord(response: { isError: true; message: string } | { isError: false; content: (TextContent | ImageContent)[]; details: unknown }): ToolResultRecord {
  return response.isError ? errorRecord(response.message) : { content: response.content, details: response.details, isError: false }
}

export { errorRecord as toolErrorRecord }

/**
 * 消息里的图片块换成文字占位（返回新对象，不改原消息 —— 这一轮内存里的 transcript 还要用带图的那份）。
 * 落库前换（下一轮看不到之前的图，和以前一致）
 */
export function slimMessage<T extends AgentMessage>(message: T): T {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return message
  const slim = withoutImages(content)
  return slim === content ? message : ({ ...message, content: slim } as T)
}

/** 落库前的调用块：去掉 pi-ai 失败的流里留在调用块上的原始参数文本 */
function cleanAssistant(message: AssistantMessage): AssistantMessage {
  let changed = false
  const content = message.content.map((part) => {
    if (part.type !== 'toolCall') return part
    const raw = part as ToolCall & { partialJson?: unknown; partialArgs?: unknown }
    if (raw.partialJson === undefined && raw.partialArgs === undefined) return part
    changed = true
    const { partialJson: _json, partialArgs: _args, ...rest } = raw
    return rest
  })
  return changed ? { ...message, content } : message
}

/**
 * 父 agent 这一轮要落库的那段：用户消息之后的全部，去掉 system 消息（工具表 / `toolsAdded` 每轮由服务端重新给）、
 * 调用块去掉原始参数文本、图片换占位（`slimMessage`：下一轮看不到之前的图，和以前一致）
 */
export function persistedMessages(transcript: AgentTranscript): AgentMessage[] {
  return transcript.messages
    .slice(transcript.start)
    .filter((message) => message.role !== 'system')
    .map((message) => slimMessage(message.role === 'assistant' ? cleanAssistant(message) : message) as AgentMessage)
}
