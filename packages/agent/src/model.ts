import type { Api, Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

/**
 * 选模型 —— 输入是一个**显式的参数对象**，本包不读 `process.env`。
 *
 * 环境变量怎么解析（`AGENT_PROVIDER` / `AGENT_MODEL` / `AGENT_BASE_URL` / `AGENT_API` /
 * `AGENT_API_KEY`，以及没给 key 时按提供方退回它自己的环境变量）是宿主的事，
 * 在 `apps/server/config.ts` 和 `apps/server/agent/` 里。这样这个包测起来不用摆弄环境，
 * 换一个宿主（CLI、别的服务）也不会被一份它不认识的环境约定绑住。
 *
 * 三条路：
 * - **内置预设**（目前只有 `ollama`，见 {@link PROVIDER_PRESETS}）：pi 的注册表里没有它，
 *   但地址、线协议、兼容开关都是固定的，不该让每个人在环境变量里重抄一遍；
 * - **注册表里有的**（`provider` + `model` 能被 pi 的 `getBuiltinModel` 认出来）：直接用；
 * - **给了 `baseUrl`**：OpenAI 兼容端点 / 代理 —— 构造一个自定义 `Model`，`api` 决定走哪种线协议。
 *   注册表里恰好也有这个模型的话，以它的元数据（上下文窗口、价格）为底，只换掉地址 ——
 *   但**对话中途的系统消息一律关掉**（{@link CUSTOM_ENDPOINT_COMPAT}）。
 */

/** 自定义端点支持的线协议。只开这两种：OpenAI 兼容端点和 Anthropic 兼容代理覆盖了几乎所有自建场景 */
export const CUSTOM_MODEL_APIS = ['openai-completions', 'anthropic-messages'] as const
export type CustomModelApi = (typeof CUSTOM_MODEL_APIS)[number]

export interface AgentModelOptions {
  provider: string
  model: string
  /** 给了就是自定义端点 */
  baseUrl?: string
  /** 自定义端点的线协议；不给时取注册表里同名模型的，没有则 `openai-completions` */
  api?: string
  apiKey?: string
  /**
   * 模型吃不吃图片输入（`view_node_media` 只给吃图片的模型）。不给 = 按注册表的元数据，自定义端点 / 预设默认只吃文字；
   * 给了就覆盖：自建的多模态端点声明 `true`，注册表里的模型也可以用 `false` 关掉。
   */
  imageInput?: boolean
  /**
   * 上下文窗口（token）。不给 = 按注册表的元数据，自定义端点 / 预设是 {@link CUSTOM_DEFAULTS} 的保守值；
   * 给了就覆盖（注册表里的模型也可以改）。它决定跨轮历史的 token 预算和「超出上下文窗口」的判断
   */
  contextWindow?: number
  /**
   * 模型单次最多输出多少 token（模型的能力，不是每次请求的上限）。不给 = 按注册表 / {@link CUSTOM_DEFAULTS}；
   * 每次请求实际的输出上限还要再和宿主的上限取小（`model-stream.ts` 的 `outputTokenLimit`）
   */
  maxTokens?: number
}

export interface ResolvedAgentModel {
  model: Model<Api>
  apiKey: string
  /** 给人看的模型名（`AgentSessionView.model`） */
  label: string
}

export type ModelResolution =
  | { ok: true; value: ResolvedAgentModel }
  | { ok: false; reason: string }

/** 自定义端点没有元数据可查，给一组保守的默认值（`contextWindow` / `maxTokens` 可用 {@link AgentModelOptions} 覆盖） */
const CUSTOM_DEFAULTS = {
  reasoning: false,
  input: ['text'] as ('text' | 'image')[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
}

/**
 * pi 注册表之外、但形状固定的提供方。
 *
 * **ollama**：本机 `ollama serve` 的 OpenAI 兼容端点（`/v1`）。本地模型和 `:cloud` 云模型
 * （ollama 替你转发到 ollama.com）走的是同一个口子，所以 `AGENT_MODEL` 写 `ollama list` 里的名字即可，
 * 如 `deepseek-v4.1-flash:1017-cloud`。
 * - **不要 key**：本机端点不鉴权，OpenAI SDK 又要求一个非空值，给个占位；云模型的鉴权是
 *   `ollama signin` 存在 ollama 那边的，不经过我们。显式给了 key（远端带鉴权的 ollama）照样用；
 * - **compat 写死而不靠 pi 按 URL 猜**：pi 只认得一批云厂商的域名，`127.0.0.1:11434` 会落到
 *   「标准 OpenAI」那一档 —— 发 `developer` 角色、`store`、`reasoning_effort`、`strict` 工具定义、
 *   `max_completion_tokens`，这些 ollama 的兼容层要么不认、要么静默丢掉（`developer` 角色被丢
 *   就等于系统提示词没了）。全部按最保守的老式 Chat Completions 写法发；
 * - **地址可覆盖**：`baseUrl` 给了就用它（ollama 跑在别的机器 / 端口上）。
 */
interface ProviderPreset {
  baseUrl: string
  api: CustomModelApi
  /** 不给 key 时用的占位；没有这一项的预设仍然要求 key */
  placeholderApiKey?: string
  compat?: OpenAICompletionsCompat
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    placeholderApiKey: 'ollama',
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    },
  },
}

/**
 * 自定义端点上强制关掉的 compat 开关。
 *
 * pi 1.x 的注册表给新一代 Anthropic / OpenAI 模型标了 `supportsMidConvoSystemMessages`（Anthropic 的还有
 * `supportsMidConvoToolChanges`）：`load_skill` 之后 pi 在 transcript 里插一条带 `toolsAdded` 的 system 消息，
 * 开着这两个开关时 SDK 把它发成对话中途的 system 块 / `tool_addition` 块并带上相应的 beta 头。
 * 这是官方端点刚有的能力，自建的兼容端点、代理（LiteLLM、one-api、各家「Anthropic 兼容」网关）多半不认 ——
 * 轻则 400，重则静默丢掉新工具的定义。关掉之后 SDK 退回老写法：system 消息并进开头的系统提示、工具表整份重发。
 * 只在给了 `baseUrl` 的分支里改；官方地址（注册表分支）保持注册表的默认。
 */
export const CUSTOM_ENDPOINT_COMPAT = {
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolChanges: false,
} as const

function isCustomApi(value: string): value is CustomModelApi {
  return (CUSTOM_MODEL_APIS as readonly string[]).includes(value)
}

export function resolveAgentModel(options: AgentModelOptions): ModelResolution {
  const provider = options.provider.trim()
  const modelId = options.model.trim()
  if (!provider || !modelId) return { ok: false, reason: '没有配置模型（provider / model 为空）' }

  const preset = PROVIDER_PRESETS[provider]
  const baseUrl = options.baseUrl?.trim() || preset?.baseUrl || ''
  const api = options.api?.trim() || preset?.api || ''
  const apiKey = options.apiKey?.trim() || preset?.placeholderApiKey || ''

  if (api && !isCustomApi(api)) {
    return { ok: false, reason: `不支持的线协议 ${api}（只支持 ${CUSTOM_MODEL_APIS.join(' / ')}）` }
  }

  // getBuiltinModel 的类型按注册表字面量收窄；这里的值来自配置，只能放宽了查
  const registered = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined

  let model: Model<Api>
  if (baseUrl) {
    model = {
      ...CUSTOM_DEFAULTS,
      ...(registered ?? {}),
      id: modelId,
      name: registered?.name ?? modelId,
      provider,
      api: (api || registered?.api || 'openai-completions') as Api,
      baseUrl,
      // 预设的 compat 整份替换注册表的；两种情况都再压上「不发对话中途的 system 消息」
      compat: { ...(preset?.compat ?? registered?.compat ?? {}), ...CUSTOM_ENDPOINT_COMPAT },
    }
  } else if (registered) {
    if (api && api !== registered.api) {
      return { ok: false, reason: `${provider}/${modelId} 的线协议是 ${registered.api}；改协议要同时给 baseUrl` }
    }
    model = registered
  } else {
    return {
      ok: false,
      reason: `pi 的模型注册表里没有 ${provider}/${modelId}；自建端点请同时配置 baseUrl 与 api`,
    }
  }

  if (!apiKey) return { ok: false, reason: `没有 ${provider} 的 API key` }

  // 声明了就覆盖（注册表里的对象是共享的，复制一份再改）
  if (options.imageInput !== undefined) {
    model = { ...model, input: options.imageInput ? ['text', 'image'] : ['text'] }
  }
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = options[field]
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      return { ok: false, reason: `${field} 必须是正整数（现在是 ${value}）` }
    }
  }
  if (options.contextWindow !== undefined) model = { ...model, contextWindow: options.contextWindow }
  if (options.maxTokens !== undefined) model = { ...model, maxTokens: options.maxTokens }
  if (model.maxTokens >= model.contextWindow) {
    return { ok: false, reason: `maxTokens（${model.maxTokens}）必须小于 contextWindow（${model.contextWindow}）` }
  }

  return { ok: true, value: { model, apiKey, label: model.name || modelId } }
}
