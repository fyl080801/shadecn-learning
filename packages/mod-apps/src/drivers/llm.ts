import { normalizeContext, type ImageContent, type TextContent } from '@earendil-works/pi-ai'
import { resolveAgentModel } from '@shadecn/agent/model'
import { AGENT_CLIENT_IDENTITY, streamUpstream } from '@shadecn/agent/model-stream'
import { AppError, type ParamSchema } from '../contract.ts'
import { defineDriver, type ProviderDriver } from '../driver.ts'
import { decodeDataUrl } from '../http.ts'

/**
 * 语言模型驱动（docs/29 §4.3）：和画布 agent **走同一条模型通路** —— `@shadecn/agent/model` 的 `resolveAgentModel` 选模型
 * （`ollama` 预设：本机 `/v1`、不要 key、保守的兼容开关），`@shadecn/agent/model-stream` 的 `streamUpstream` 按线协议发请求。
 * 所以这里不再写一份 OpenAI 兼容客户端，agent 那边修过的兼容问题这里自动就有。
 *
 * 用 {@link createLlmDriver} 生成：`ollama` 是一个固定了 pi 提供方的实例；以后要接别的（`openai` / 自建的兼容端点），
 * 在注册表里多一行 `createLlmDriver({ type: '…', provider: '…' })` 即可。
 *
 * 操作 `chat`：一问一答（不带工具、不留历史）。模型写在应用上（`model`，一个或多个；ollama 写 `ollama list` 里的名字），
 * 每个模型启动时各解析一次，解析不了的只把那一个标成不可用。`options`：`system`（系统提示词）、`maxTokens`、
 * `imageInput`（模型吃图片时打开 `images` 参数；某个模型不吃图，应用表里给它 `models.<id>.params.images: null`）。
 */

interface LlmProvider {
  provider: string
  baseUrl?: string
  apiKey?: string
}

export interface LlmDriverOptions {
  type: string
  description: string
  /** pi 的提供方名（含本仓库的预设，如 `ollama`） */
  provider: string
}

const DEFAULT_MAX_TOKENS = 4096

export function createLlmDriver(options: LlmDriverOptions): ProviderDriver<LlmProvider> {
  return defineDriver<LlmProvider>({
    type: options.type,
    description: options.description,
    parseProvider(fields) {
      const baseUrl = fields.url('baseUrl')
      const apiKey = fields.secret('apiKey')
      return { provider: options.provider, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) }
    },
    operations: {
      chat: {
        description: '一问一答的文字生成',
        prepare(fields, provider) {
          const system = fields.string('system')
          const maxTokens = fields.integer('maxTokens', { default: DEFAULT_MAX_TOKENS })!
          const imageInput = fields.boolean('imageInput', { default: false })!
          // 每个模型启动时解析一次（checkModel），执行时按定下来的模型取
          const resolutions = new Map<string, ReturnType<typeof resolveAgentModel>>()
          const resolve = (modelId: string) => {
            let resolved = resolutions.get(modelId)
            if (!resolved) {
              resolved = resolveAgentModel({
                provider: provider.provider,
                model: modelId,
                ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
                ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
                imageInput,
              })
              resolutions.set(modelId, resolved)
            }
            return resolved
          }

          const params: ParamSchema = {
            prompt: { type: 'string', required: true, description: '用户输入' },
            ...(system === undefined ? { system: { type: 'string', description: '系统提示词' } } : {}),
            temperature: { type: 'number', min: 0, max: 2 },
            ...(imageInput ? { images: { type: 'images', description: '图片（data URL）', maxLength: 8 } } : {}),
          }
          return {
            category: 'text',
            params,
            checkModel: (modelId) => {
              const resolved = resolve(modelId)
              return resolved.ok ? null : resolved.reason
            },
            async submit(values, ctx, modelId) {
              const resolved = resolve(modelId!)
              // 不可用的模型执行层就挡掉了，这里一定是 ok
              if (!resolved.ok) throw new AppError('unavailable', resolved.reason)
              const { model, apiKey } = resolved.value
              const images: ImageContent[] = ((values.images as string[] | undefined) ?? []).map((url) => {
                const decoded = decodeDataUrl(url)
                if (!decoded) throw new AppError('invalid_params', 'images 只收 data:image/…;base64,…')
                return { type: 'image', data: Buffer.from(decoded.data).toString('base64'), mimeType: decoded.mimeType }
              })
              const content: (TextContent | ImageContent)[] = [{ type: 'text', text: values.prompt as string }, ...images]
              const systemPrompt = system ?? (values.system as string | undefined)
              const stream = streamUpstream(
                model,
                normalizeContext({
                  ...(systemPrompt ? { systemPrompt } : {}),
                  messages: [{ role: 'user', content, timestamp: Date.now() }],
                }),
                {
                  apiKey,
                  signal: ctx.signal,
                  maxTokens: Math.min(maxTokens, model.maxTokens),
                  identity: AGENT_CLIENT_IDENTITY,
                  maxRetries: 1,
                  fetch: ctx.fetch,
                  ...(values.temperature !== undefined ? { temperature: values.temperature as number } : {}),
                },
              )
              const message = await stream.result()
              if (message.stopReason === 'aborted') throw new AppError('aborted', '模型请求已中止')
              if (message.stopReason === 'error') throw new AppError('upstream', `模型请求失败：${message.errorMessage ?? '未知错误'}`)
              const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
              const thinking = message.content.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : [])).join('')
              return {
                done: true,
                output: {
                  outputs: [{ kind: 'text', text, mimeType: 'text/plain', ...(thinking ? { meta: { thinking } } : {}) }],
                  usage: {
                    inputTokens: message.usage.input,
                    outputTokens: message.usage.output,
                    totalTokens: message.usage.input + message.usage.output,
                  },
                },
              }
            },
          }
        },
      },
    },
  })
}
