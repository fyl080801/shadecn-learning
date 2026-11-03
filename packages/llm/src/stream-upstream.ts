import type { Api, AssistantMessageEventStream, ClientIdentity, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { streamSimple as anthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as openaiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as openaiResponses } from '@earendil-works/pi-ai/api/openai-responses'

/**
 * 按线协议调模型。复制自 `@shadecn/agent` 的 `model-stream.ts`，只留应用驱动要的这一段：工具调用 id 的补齐、参数过长掐断都是 agent 的事，这里一问一答用不上。
 * Bedrock、Vertex 这些要凭据链的线协议不开放，同 agent。
 */

export const SERVED_MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

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

/** 请求怎么标识自己：不带归属头（pi 默认把请求归到它的 OpenRouter 应用，那是部署方的决定），UA 用自己的名字 */
export const AGENT_CLIENT_IDENTITY: ClientIdentity = { userAgent: { custom: 'shadecn-agent' }, attribution: null }
