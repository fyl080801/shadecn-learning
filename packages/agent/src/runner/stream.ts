import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEventStream, Model } from '@earendil-works/pi-ai'
import { streamSimple as anthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as openaiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as openaiResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { createId } from '@shadecn/shared/id'

/**
 * runner 交给 pi `Agent` 的 `streamFn`（pi 1.x 起必填，agent-core 不再自带提供方目录）。
 *
 * 按 `model.api` 直接分派到三种线协议的实现 —— 正好是网关的模型代理肯转发的三种（`gateway.ts`）；
 * 别的协议到了网关也会被拒，这里先报清楚。不经 pi 的 `Models` 集合 / `/compat`：鉴权（run 短令牌）由 `Agent` 的
 * `getApiKey` 给，地址是网关的模型代理，用不着提供方注册、凭据解析那一层。
 *
 * 回复定稿时补齐工具调用 id（{@link withToolCallIds}）。
 */
export const runnerStreamFn: StreamFn = (model, context, options) => {
  switch (model.api) {
    case 'openai-completions':
      return withToolCallIds(openaiCompletions(model as Model<'openai-completions'>, context, options))
    case 'openai-responses':
      return withToolCallIds(openaiResponses(model as Model<'openai-responses'>, context, options))
    case 'anthropic-messages':
      return withToolCallIds(anthropicMessages(model as Model<'anthropic-messages'>, context, options))
    default:
      throw new Error(`runner 不支持的线协议 ${model.api}（只支持 openai-completions / openai-responses / anthropic-messages）`)
  }
}

/**
 * 上游没给调用 id 时 pi-ai 填空串（`openai-completions` 的 `toolCall.id || ""`）；同一条回复里两个调用同 id 也有端点会给。
 * 空 id 过不了网关的校验（`protocol.ts` 的 id 必须非空）—— 上报的事件整批被拒、`/canvas/tool` 400，这一轮就断了；
 * 同 id 则让服务端分不清是哪一次调用。所以在 pi 拿到定稿消息（`result()`）时**就地**补一个新 id：
 * pi 之后执行工具、发 tool_execution_* / message_end、把结果放进上下文用的都是这同一个对象，所以 id 从此一致，
 * 下一次请求发给上游的也是它（上游本来就不认识这个调用的 id）。流式过程中的半成品消息不上报 id，不用管。
 * 不改服务端校验：空 id 依旧是畸形输入。
 */
export function withToolCallIds(stream: AssistantMessageEventStream, mint: () => string = () => createId('call')): AssistantMessageEventStream {
  const result = stream.result.bind(stream)
  stream.result = async () => {
    const message = await result()
    const seen = new Set<string>()
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue
      if (!part.id || seen.has(part.id)) part.id = mint()
      seen.add(part.id)
    }
    return message
  }
  return stream
}
