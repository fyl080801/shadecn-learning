import { normalizeContext, type ImageContent, type TextContent } from '@earendil-works/pi-ai'
import { resolveProviderModel } from '@shadecn/agent/llm-providers'
import { resolveAgentModel, type ModelResolution } from '@shadecn/agent/model'
import { AGENT_CLIENT_IDENTITY, streamUpstream } from '@shadecn/agent/model-stream'
import { AppError, type ParamSchema } from '../contract.ts'
import type { LlmProviderTable } from '@shadecn/server-kit/llm'
import { defineDriver, type DriverEnv, type Operation, type ProviderDriver } from '../driver.ts'
import { decodeDataUrl } from '../http.ts'

/**
 * 语言模型驱动（docs/29 §4.3）：和画布 agent **走同一条模型通路** —— `@shadecn/agent/model` 选模型、
 * `@shadecn/agent/model-stream` 的 `streamUpstream` 按线协议发请求。所以这里不再写一份 OpenAI 兼容客户端，agent 那边修过的兼容问题这里自动就有。
 *
 * 两种驱动共用同一个操作（`text`，{@link chatOperation}），只差「模型怎么解析」：
 * - **`llm`**（{@link llmServiceDriver}）：引用语言服务提供方（配置的 `llm.providers`，`providers.<id>: { type: llm, provider: <key> }`），
 *   解析走 `resolveProviderModel`（同 agent）。`llm.providers` 里带模型的提供方还会自动合成一个这种实例（`../llm-apps.ts`）；
 * - **{@link createLlmDriver}**：固定了 pi 提供方的实例，地址和 key 写在 `modules.apps.providers` 里（`ollama`）。
 *
 * 操作 `text`：一问一答（不带工具、不留历史）。模型写在条目上（`model`；ollama 写 `ollama list` 里的名字），
 * 启动时解析一次，解析不了这个应用就标成不可用。`options`：`system`（系统提示词）、`maxTokens`、
 * `imageInput`（模型吃图片时打开 `images` 参数；这个模型不吃图，条目写 `params: { images: null }`）。
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

/** 两种驱动的差异：模型怎么解析、`imageInput` 不写时开不开 `images` */
interface ChatModels<Provider> {
  imageInputDefault(provider: Provider): boolean
  /** `imageInput` 是应用的 `options.imageInput`（没写 = undefined） */
  resolve(provider: Provider, modelId: string, imageInput: boolean | undefined): ModelResolution
}

function chatOperation<Provider>(models: ChatModels<Provider>): Operation<Provider> {
  return {
    description: '一问一答的文字生成',
    prepare(fields, provider) {
      const system = fields.string('system')
      const maxTokens = fields.integer('maxTokens', { default: DEFAULT_MAX_TOKENS })!
      const explicitImageInput = fields.boolean('imageInput')
      const imageInput = explicitImageInput ?? models.imageInputDefault(provider)
      // 启动时解析一次（checkModel），执行时用同一份
      let resolution: ModelResolution | undefined
      const resolve = (modelId: string) => (resolution ??= models.resolve(provider, modelId, explicitImageInput))

      const params: ParamSchema = {
        prompt: { type: 'string', required: true, description: '用户输入' },
        ...(system === undefined ? { system: { type: 'string', description: '系统提示词' } } : {}),
        temperature: { type: 'number', min: 0, max: 2 },
        ...(imageInput ? { images: { type: 'images', description: '图片（data URL）', maxLength: 8 } } : {}),
      }
      return {
        params,
        checkModel: (modelId) => {
          const resolved = resolve(modelId)
          return resolved.ok ? null : resolved.reason
        },
        async submit(values, ctx, modelId) {
          const resolved = resolve(modelId!)
          // 不可用的应用执行层就挡掉了，这里一定是 ok
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
  }
}

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
      text: chatOperation<LlmProvider>({
        imageInputDefault: () => false,
        resolve: (provider, modelId, imageInput) =>
          resolveAgentModel({
            provider: provider.provider,
            model: modelId,
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
            imageInput: imageInput ?? false,
          }),
      }),
    },
  })
}

/** 引用一个语言服务提供方的实例：提供方表、读 key 的函数都是启动时给定的 */
interface LlmServiceProvider {
  id: string
  table: LlmProviderTable
  envVar: DriverEnv['envVar']
}

export const llmServiceDriver = defineDriver<LlmServiceProvider>({
  type: 'llm',
  description: '语言服务提供方（配置的 llm.providers，同画布 agent）',
  parseProvider(fields, env) {
    const id = fields.string('provider', { required: true })
    if (!Object.hasOwn(env.llmProviders, id)) {
      const known = Object.keys(env.llmProviders)
      throw new Error(`${fields.at}：provider ${id} 不在 llm.providers 里（${known.length > 0 ? `有：${known.join('、')}` : '那里还是空的'}）`)
    }
    return { id, table: env.llmProviders, envVar: (name) => env.envVar(name) }
  },
  operations: {
    text: chatOperation<LlmServiceProvider>({
      imageInputDefault: (provider) => provider.table[provider.id]!.models.some((model) => model.input?.includes('image')),
      resolve: (provider, modelId, imageInput) =>
        resolveProviderModel({
          table: provider.table,
          provider: provider.id,
          model: modelId,
          envVar: provider.envVar,
          ...(imageInput !== undefined ? { imageInput } : {}),
        }),
    }),
  },
})
