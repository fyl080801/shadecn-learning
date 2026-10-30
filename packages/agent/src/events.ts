import type { AgentEvent } from '@mariozechner/pi-agent-core'
import {
  AGENT_CANVAS_CHANGE_EVENT,
  AGENT_SKILL_LOADED_EVENT,
  AGENT_USER_MESSAGE_EVENT,
  AgentEventType,
  type AgentCanvasChangeMessage,
  type AgentSkillLoadedMessage,
  type AgentChatMessage,
  type AgentStreamEvent,
  type AgentToolCallMetadata,
  type AgentToolCallView,
} from '@shadecn/shared/agent'
import { createId } from '@shadecn/shared/id'
import type { RunnerEvent } from './protocol.ts'
import { LOAD_SKILL_TOOL_NAME } from './skills/registry.ts'

/**
 * pi 的 `AgentEvent` → 线上事件（AG-UI 子集，形状见 `@shadecn/shared/agent`）。
 *
 * **整个映射只在这一个文件里**：路由只管把这里吐出来的对象逐帧写成 `data: <JSON>\n\n`，
 * 不认识任何一种事件。将来换协议（或者 AG-UI 加字段）只改这里。
 *
 * 二期起 pi 跑在沙箱里的 runner 中（docs/22 §4），**映射仍在服务端这里做**：runner 只把 pi 事件裁成
 * `protocol.ts` 的 `RunnerEvent`（同名同形、去掉用不着的字段）上报，编排层把它们原样喂给 {@link RunEventMapper.handle}。
 * 映射放在服务端，是因为 runner 随时可能被杀（中止 / 失权 / 超时）：收尾帧、落库的 assistant 消息
 * 都得由服务端按已经收到的事件补齐，映射状态必须在服务端。
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
 * - 思考内容（thinking）不外发：那是模型的草稿，不是给人看的回复。
 * - 画布改动通知（docs/20 §3.10.2）：CUSTOM `agent.canvas-change`，`value` 就是对话里存的那条
 *   `canvas-change` 消息。什么时候发由编排层定（跨轮差异紧跟用户消息回显；运行中的那种在它真正进入
 *   模型上下文时 —— pi 把 steer 的消息放进上下文的那一刻），这里只管形状。
 * - 技能加载（docs/23 §3.6）：`load_skill` **不作为工具调用条目出现**（不发 TOOL_CALL_*，也不进 assistant 消息的
 *   `toolCalls`）；网关加载成功时发 CUSTOM `agent.skill-loaded`，`value` 就是对话里存的那条 `skill-loaded` 消息。
 */

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

export interface RunEventMapper {
  /** RUN_STARTED + 回显用户消息 */
  start(userMessage: UserChatMessage): AgentStreamEvent[]
  /** 吃一个 pi 事件（或 runner 上报的裁剪版），吐出零到多个线上事件 */
  handle(event: AgentEvent | RunnerEvent): AgentStreamEvent[]
  /** 一条画布改动通知（先关掉没关的文字段：通知插在两段文字之间） */
  canvasChange(message: AgentCanvasChangeMessage): AgentStreamEvent[]
  /** 一次技能加载（同上，先关文字段） */
  skillLoaded(message: AgentSkillLoadedMessage): AgentStreamEvent[]
  /** 收尾：关掉没关的文字段，再发 RUN_FINISHED / RUN_ERROR */
  finish(outcome: RunOutcome): AgentStreamEvent[]
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
  const calls = new Map<string, AgentToolCallView>()
  let textOpen = false
  let modelError: string | undefined

  function closeText(out: AgentStreamEvent[]) {
    if (!textOpen) return
    textOpen = false
    out.push({ type: AgentEventType.TEXT_MESSAGE_END, messageId, timestamp: now() })
  }

  function text(delta: string, out: AgentStreamEvent[]) {
    if (!delta) return
    let chunk = delta
    if (!textOpen) {
      textOpen = true
      out.push({ type: AgentEventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: now() })
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
            id: event.toolCallId,
            name: event.toolName,
            summary,
            status: 'running',
          }
          calls.set(call.id, call)
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
            call = { id: event.toolCallId, name: event.toolName, summary: event.toolName, status: 'running' }
            calls.set(call.id, call)
            message.toolCalls.push(call)
          }
          const body = resultText(event.result)
          if (event.isError) {
            call.status = 'error'
            call.error = body || '工具调用失败'
          } else {
            call.status = 'done'
            call.summary = resultSummary(event.result) ?? call.summary
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

    finish(outcome) {
      const out: AgentStreamEvent[] = []
      closeText(out)
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
