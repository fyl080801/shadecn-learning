import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple as anthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as openaiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as openaiResponses } from '@earendil-works/pi-ai/api/openai-responses'

/**
 * runner 交给 pi `Agent` 的 `streamFn`（pi 1.x 起必填，agent-core 不再自带提供方目录）。
 *
 * 按 `model.api` 直接分派到三种线协议的实现 —— 正好是网关的模型代理肯转发的三种（`gateway.ts`）；
 * 别的协议到了网关也会被拒，这里先报清楚。不经 pi 的 `Models` 集合 / `/compat`：鉴权（run 短令牌）由 `Agent` 的
 * `getApiKey` 给，地址是网关的模型代理，用不着提供方注册、凭据解析那一层。
 */
export const runnerStreamFn: StreamFn = (model, context, options) => {
  switch (model.api) {
    case 'openai-completions':
      return openaiCompletions(model as Model<'openai-completions'>, context, options)
    case 'openai-responses':
      return openaiResponses(model as Model<'openai-responses'>, context, options)
    case 'anthropic-messages':
      return anthropicMessages(model as Model<'anthropic-messages'>, context, options)
    default:
      throw new Error(`runner 不支持的线协议 ${model.api}（只支持 openai-completions / openai-responses / anthropic-messages）`)
  }
}
