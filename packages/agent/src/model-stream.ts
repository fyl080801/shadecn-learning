import type { ProxyAssistantMessageEvent } from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ClientIdentity,
  Model,
  SimpleStreamOptions,
  ToolCall,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import { streamSimple as anthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as openaiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as openaiResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { createId } from '@shadecn/shared/id'
import { TOOL_LIMITS } from './tools.ts'

/**
 * 服务端调用模型（docs/22 §4.3）：网关的 `/model/<agentId>/api/stream` 用它带着真实 key 调上游，
 * 把 pi-ai 的事件流换成 pi `streamProxy` 认的 {@link ProxyAssistantMessageEvent} 下发给 runner。
 * **只在服务端**：runner 不 import 它（真实 key、上游地址、模型参数都不进沙箱）。
 *
 * 这里定的是「服务端说了算」的那几项：线协议分派、`identity`、输出 token 上限、工具调用 id 的补齐、
 * 工具参数过长时掐断（pi #9265 的缓解）。用哪个模型、哪把 key、重试几次、`sessionId` 由网关 / 编排层给。
 */

/** 服务端会调的线协议（Bedrock、Vertex 等要凭据链的不在这次放开，docs/22 §4.3 已定第 9 条） */
export const SERVED_MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

export function isServedModelApi(api: string): boolean {
  return (SERVED_MODEL_APIS as readonly string[]).includes(api)
}

/** 按 `model.api` 分派到三种线协议的 `streamSimple`（不经 `/compat`：提供方注册、凭据解析用不上，key 由调用方给） */
export function streamUpstream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions): AssistantMessageEventStream {
  switch (model.api) {
    case 'openai-completions':
      return openaiCompletions(model as Model<'openai-completions'>, context, options)
    case 'openai-responses':
      return openaiResponses(model as Model<'openai-responses'>, context, options)
    case 'anthropic-messages':
      return anthropicMessages(model as Model<'anthropic-messages'>, context, options)
    default:
      throw new Error(`服务端不支持的线协议 ${model.api}（只支持 ${SERVED_MODEL_APIS.join(' / ')}）`)
  }
}

/**
 * 请求怎么标识自己（docs/22 §4.3 已定第 6 条）：不带归属头（pi-agent-core 默认把请求归到 pi 的 OpenRouter 应用，那是部署方的决定），
 * UA 用自己的名字
 */
export const AGENT_CLIENT_IDENTITY: ClientIdentity = { userAgent: { custom: 'shadecn-agent' }, attribution: null }

/** 输出 token 上限的默认值（`AGENT_MAX_OUTPUT_TOKENS` 没配时）：再和模型自己的 `maxTokens` 取小 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

/** 这次请求的 `maxTokens`：min(模型的 maxTokens, 配置的上限)；输出 token 决定了工具参数最长能有多长（#9265 的第一道缓解） */
export function outputTokenLimit(model: Model<Api>, configured?: number): number {
  const cap = configured !== undefined && Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_OUTPUT_TOKENS
  return model.maxTokens > 0 ? Math.min(model.maxTokens, cap) : cap
}

/**
 * 一次工具调用的参数文本累计到多少字就掐断（#9265 的第二道缓解）：最大合法参数约 2 倍 —— 单次 data 补丁上限
 * `TOOL_LIMITS.dataBytes`（32 000 字节）是画布工具里最大的一项。pi-ai 1.4.0 在每个参数增量上整段重新解析，代价是参数长度的平方，
 * 在服务端主线程上；钉在这里，最坏情况是一两秒 CPU
 */
export const MAX_TOOL_ARGUMENT_CHARS = 2 * TOOL_LIMITS.dataBytes

/** 参数过长被掐断时给模型的话（作为那次调用的工具错误结果，这一轮继续） */
export const TOOL_ARGUMENTS_TOO_LONG = (name: string, limit: number) =>
  `模型输出的工具调用参数过长（${name || '未知工具'} 超过 ${limit} 字），服务端已掐断这次回复，这次调用没有执行；请把内容拆成多次较小的调用`

/**
 * 一次模型请求的定稿（记进服务端 transcript 的那一份，docs/22 §4.3 第 2 步）：调用 id 已补齐（和下发给 runner 的一致）、
 * 调用块上的原始参数文本已去掉。`cut` = 参数过长被掐断的调用（id → 给模型的话），runner 执行不了它们，结果由服务端给
 */
export interface ModelTurnResult {
  message: AssistantMessage
  cut: ReadonlyMap<string, string>
}

export interface ProxyFrameOptions {
  /** 参数累计超过这么多字就掐断；不给用 {@link MAX_TOOL_ARGUMENT_CHARS} */
  maxToolArgumentChars?: number
  /** 参数过长：调用方据此 abort 上游请求（之后 pi-ai 以 aborted 收尾，这里把这条回复收成「调用了工具」，被掐断的调用不带参数） */
  onArgumentsTooLong(name: string, chars: number): void
  /** 终止帧发出**之前**调：这条回复的定稿（runner 拿到终止帧就可能来执行工具，transcript 必须先记好） */
  onResult?(result: ModelTurnResult): void
  /** 补调用 id；不给用 `createId('call')` */
  mintId?: () => string
}

type Usage = AssistantMessage['usage']

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const NO_CUT: ReadonlyMap<string, string> = new Map()

/** 定稿的调用块：去掉 pi-ai 流式解析留下的原始参数文本（失败的流里会留着），只发可序列化的定义 */
function finalToolCall(call: ToolCall): ToolCall {
  const { partialJson: _json, partialArgs: _args, ...rest } = call as ToolCall & { partialJson?: unknown; partialArgs?: unknown }
  return rest
}

/** 下发过的一个内容块：还开着（start 发了、end 没发）/ 关了；调用块记下发给 runner 的 id */
interface ForwardedBlock {
  open: boolean
  id?: string
}

/**
 * pi-ai 的事件流 → 下发的帧（逐个 yield；最后一帧总是 `done` / `error`）。
 *
 * - **`toolcall_delta` 不转发**：`streamProxy` 在 `toolcall_start` 建空的调用块、`toolcall_end` 整个覆盖，runner 拿到的定稿一样；
 *   转发的话 runner 那边的 `streamProxy` 也要每个增量整段解析一次（#9265）。服务端只数它们的长度；
 * - **调用 id 在这里补齐**：上游没给（pi-ai 填空串）或同一条回复里重复的，`toolcall_end` 时换一个新的，随帧交给 runner
 *   （runner 执行、上报的和服务端 transcript 里记的都是这一个）；
 * - **参数过长**：通知调用方掐断上游；等 pi-ai 收尾后把这条回复收成「调用了工具」—— 还开着的块补上结束帧，
 *   被掐断的调用（及同时还没收完的调用）以空参数下发、记进 `cut`，其后才开始的块不下发也不记；终止帧是 `done { reason: 'toolUse' }`。
 *   runner 照常「执行」它们（参数过不了 schema 就本地报错；过得了的到网关被拒），服务端在下一次请求时把「参数过长」作为工具错误结果交给模型，
 *   这一轮继续（docs/22 §4.3「#9265」对策 ②）。
 */
export async function* proxyFramesOf(stream: AssistantMessageEventStream, options: ProxyFrameOptions): AsyncGenerator<ProxyAssistantMessageEvent> {
  const limit = options.maxToolArgumentChars ?? MAX_TOOL_ARGUMENT_CHARS
  const mint = options.mintId ?? (() => createId('call'))
  const argumentChars = new Map<number, number>()
  const seenIds = new Set<string>()
  const forwarded = new Map<number, ForwardedBlock>()
  let tooLong: { name: string; chars: number } | null = null
  let terminal = false

  /** 调用 id：空的、这条回复里已经用过的换一个 */
  const idFor = (raw: string) => {
    const id = !raw || seenIds.has(raw) ? mint() : raw
    seenIds.add(id)
    return id
  }

  /** 正常收尾的定稿：调用块换成下发过的 id、去掉原始参数文本；没下发过的块（不该有）原样留着 */
  const settled = (message: AssistantMessage): AssistantMessage => ({
    ...message,
    content: message.content.map((part, index) => {
      if (part.type !== 'toolCall') return part
      const id = forwarded.get(index)?.id
      return { ...finalToolCall(part), ...(id !== undefined ? { id } : {}) }
    }),
  })

  for await (const event of stream) {
    if (terminal) break
    if (tooLong) {
      // 已经掐断：等 pi-ai 收尾，中间的一概不发；收尾时把下发过的块收好，以「调用了工具」结束
      if (event.type !== 'done' && event.type !== 'error') continue
      terminal = true
      const source = event.type === 'done' ? event.message : event.error
      const usage = source.usage ?? EMPTY_USAGE
      const reason = TOOL_ARGUMENTS_TOO_LONG(tooLong.name, limit)
      const cut = new Map<string, string>()
      const closing: ProxyAssistantMessageEvent[] = []
      const content: AssistantMessage['content'] = []
      for (const index of [...forwarded.keys()].sort((a, b) => a - b)) {
        const block = forwarded.get(index)!
        const part = source.content[index]
        if (!part) continue
        if (part.type === 'toolCall') {
          if (!block.open) {
            content.push({ ...finalToolCall(part), ...(block.id !== undefined ? { id: block.id } : {}) })
            continue
          }
          const call: ToolCall = { type: 'toolCall', id: idFor(part.id), name: part.name, arguments: {} }
          cut.set(call.id, reason)
          closing.push({ type: 'toolcall_end', contentIndex: index, toolCall: call })
          content.push(call)
          continue
        }
        if (block.open) {
          closing.push(part.type === 'text' ? { type: 'text_end', contentIndex: index } : { type: 'thinking_end', contentIndex: index })
        }
        content.push(part)
      }
      const message: AssistantMessage = { ...source, content, stopReason: 'toolUse', usage }
      // 被掐断时 pi-ai 以 aborted 收尾、带着原因；这条回复按「调用了工具」收，不带它
      delete message.errorMessage
      options.onResult?.({ message, cut })
      yield* closing
      yield { type: 'done', reason: 'toolUse', usage }
      continue
    }
    switch (event.type) {
      case 'start':
        yield { type: 'start' }
        break
      case 'text_start':
        forwarded.set(event.contentIndex, { open: true })
        yield { type: 'text_start', contentIndex: event.contentIndex }
        break
      case 'text_delta':
        yield { type: 'text_delta', contentIndex: event.contentIndex, delta: event.delta }
        break
      case 'text_end': {
        forwarded.set(event.contentIndex, { open: false })
        const block = event.partial.content[event.contentIndex]
        const signature = block?.type === 'text' ? block.textSignature : undefined
        yield { type: 'text_end', contentIndex: event.contentIndex, ...(signature !== undefined ? { contentSignature: signature } : {}) }
        break
      }
      case 'thinking_start':
        forwarded.set(event.contentIndex, { open: true })
        yield { type: 'thinking_start', contentIndex: event.contentIndex }
        break
      case 'thinking_delta':
        yield { type: 'thinking_delta', contentIndex: event.contentIndex, delta: event.delta }
        break
      case 'thinking_end': {
        forwarded.set(event.contentIndex, { open: false })
        const block = event.partial.content[event.contentIndex]
        const signature = block?.type === 'thinking' ? block.thinkingSignature : undefined
        yield { type: 'thinking_end', contentIndex: event.contentIndex, ...(signature !== undefined ? { contentSignature: signature } : {}) }
        break
      }
      case 'toolcall_start': {
        forwarded.set(event.contentIndex, { open: true })
        const block = event.partial.content[event.contentIndex]
        const call = block?.type === 'toolCall' ? block : null
        yield { type: 'toolcall_start', contentIndex: event.contentIndex, id: call?.id ?? '', toolName: call?.name ?? '' }
        break
      }
      case 'toolcall_delta': {
        const chars = (argumentChars.get(event.contentIndex) ?? 0) + event.delta.length
        argumentChars.set(event.contentIndex, chars)
        if (chars > limit) {
          const block = event.partial.content[event.contentIndex]
          tooLong = { name: block?.type === 'toolCall' ? block.name : '', chars }
          options.onArgumentsTooLong(tooLong.name, chars)
        }
        break
      }
      case 'toolcall_end': {
        const call = { ...finalToolCall(event.toolCall), id: idFor(event.toolCall.id) }
        forwarded.set(event.contentIndex, { open: false, id: call.id })
        yield { type: 'toolcall_end', contentIndex: event.contentIndex, toolCall: call }
        break
      }
      case 'done': {
        terminal = true
        // 我们从不要延迟响应（`deferred`），`streamProxy` 也不认它：当成出错
        if (event.reason === 'deferred') {
          const errorMessage = '上游返回了延迟响应（不支持）'
          options.onResult?.({ message: { ...settled(event.message), stopReason: 'error', errorMessage }, cut: NO_CUT })
          yield { type: 'error', reason: 'error', errorMessage, usage: event.message.usage }
          break
        }
        options.onResult?.({ message: settled(event.message), cut: NO_CUT })
        const level = event.message.providerThinkingLevel
        yield { type: 'done', reason: event.reason, usage: event.message.usage, ...(level !== undefined ? { providerThinkingLevel: level } : {}) }
        break
      }
      case 'error': {
        terminal = true
        options.onResult?.({ message: settled(event.error), cut: NO_CUT })
        const level = event.error.providerThinkingLevel
        yield {
          type: 'error',
          reason: event.reason,
          ...(event.error.errorMessage !== undefined ? { errorMessage: event.error.errorMessage } : {}),
          usage: event.error.usage ?? EMPTY_USAGE,
          ...(level !== undefined ? { providerThinkingLevel: level } : {}),
        }
        break
      }
    }
  }
}
