import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { resolveAgentModel, type AgentModelOptions, type AgentThinkingLevel, type ModelResolution } from './model.ts'

/**
 * 语言服务提供方 + 模型 id → pi 的模型：画布 agent（`default` 和模型表）和应用表的 `llm` 驱动都走这一条路（docs/26 §3.4、docs/29 §4.3）。
 *
 * 提供方的表由宿主给（配置的 `llm.providers`，形状校验在 `@shadecn/server-kit/llm`，它的类型结构上就是这里的 {@link ProviderTable}：
 * 这个包不认识配置层），环境变量经 `envVar` 读 —— 这个包不读 `process.env`。
 *
 * - **表里有这个提供方**：连接信息照表里的；`apiKeyEnv` 写了只认那个变量（没设 = 不可用，不再退回），没写才按提供方退回。
 *   `models` 非空时模型要在列表里，或者是 pi 注册表认得的 id（只想给注册表模型换地址 / key 时不用抄一遍）；
 * - **表里没有**：和 pi 的内置提供方一样 —— `provider` + `model` 走注册表 / 预设（`anthropic`、`ollama`），key 按提供方退回。
 *
 * 用不了都是 `{ ok: false, reason }`，不抛：形状不对才是启动错误（在解析配置时就抛了）。
 */

/** {@link ProviderDef} 的一个模型 */
export interface ProviderModelDef {
  readonly id: string
  readonly name?: string
  readonly input?: readonly ('text' | 'image')[]
  readonly reasoning?: boolean
  readonly contextWindow?: number
  readonly maxTokens?: number
}

/** 一个语言服务提供方 */
export interface ProviderDef {
  readonly baseUrl?: string
  readonly api?: string
  /** 只认这个环境变量；不写 = 按提供方退回 */
  readonly apiKeyEnv?: string
  readonly models: readonly ProviderModelDef[]
}

export type ProviderTable = Readonly<Record<string, ProviderDef>>

export type EnvReader = (name: string) => string | undefined

export interface ProviderModelRequest {
  table: ProviderTable
  provider: string
  model: string
  envVar: EnvReader
  thinking?: AgentThinkingLevel
  /** 调用方明确知道吃不吃图时覆盖模型定义（应用表的 `options.imageInput`） */
  imageInput?: boolean
}

/**
 * 按提供方退回 key 时读的环境变量（按顺序取第一个非空的）。
 *
 * 我们自己维护这份表，不用 pi 的 `getEnvApiKey`（pi 1.x 起它只在 `/compat` 兼容层里）：取值照 pi 0.73.1 / 1.4.0
 * `env-api-keys` 里纯 key 的那些提供方抄的，两版不一致时保持 0.73.1 的行为（我们之前一直按它跑）。
 * 刻意**不收**的：
 * - `google-vertex` / `amazon-bedrock` 的 ADC / AWS 凭据链（pi 那边回一个 `<authenticated>` 占位）——
 *   网关的模型代理只会把 key 注入成 `Authorization` / `x-api-key`，这两家的线协议它也不转发；
 * - `ANTHROPIC_AUTH_TOKEN`（pi 1.x 新加，它把它当 Bearer 头而不是 key 用），同理。
 *
 * **不要 key 的本地端点**（`ollama`）：列成空表 —— 不读任何变量，由 `./model.ts` 的预设补占位 key；
 * 远端带鉴权的 ollama 在 `llm.providers` 里写 `apiKey: $变量名`。表里没有的提供方（自建端点）同样只认 `apiKey` 引用。
 */
export const AGENT_PROVIDER_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  // OAuth token 在前（pi 0.73 的顺序）
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  // 本机端点不鉴权：不读变量，预设补占位
  ollama: [],
}

/** 按 {@link AGENT_PROVIDER_KEY_ENV} 从环境变量取 `provider` 的 key；没有（表里没有 / 都没配 / 只有空白）= `''` */
export function agentProviderApiKey(provider: string, envVar: EnvReader): string {
  const names = (Object.hasOwn(AGENT_PROVIDER_KEY_ENV, provider) && AGENT_PROVIDER_KEY_ENV[provider]) || []
  for (const name of names) {
    const value = envVar(name)?.trim()
    if (value) return value
  }
  return ''
}

export function resolveProviderModel(request: ProviderModelRequest): ModelResolution {
  const provider = request.provider.trim()
  const model = request.model.trim()
  const shared: Pick<AgentModelOptions, 'provider' | 'model' | 'thinking' | 'imageInput'> = {
    provider,
    model,
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    ...(request.imageInput !== undefined ? { imageInput: request.imageInput } : {}),
  }
  const def = Object.hasOwn(request.table, provider) ? request.table[provider] : undefined
  if (!def) return resolveAgentModel({ ...shared, apiKey: agentProviderApiKey(provider, request.envVar) })

  let apiKey: string
  if (def.apiKeyEnv !== undefined) {
    apiKey = request.envVar(def.apiKeyEnv)?.trim() ?? ''
    if (!apiKey) return { ok: false, reason: `语言服务提供方 ${provider} 的 apiKey 引用的环境变量 ${def.apiKeyEnv} 没有设置` }
  } else {
    apiKey = agentProviderApiKey(provider, request.envVar)
  }

  const modelDef = def.models.find((item) => item.id === model)
  if (def.models.length > 0 && !modelDef) {
    // getBuiltinModel 的类型按注册表字面量收窄；这里的值来自配置，只能放宽了查
    const registered = getBuiltinModel(provider as never, model as never) as Model<Api> | undefined
    if (!registered) {
      return { ok: false, reason: `语言服务提供方 ${provider} 的 models 里没有 ${model}，pi 的模型注册表里也没有（可选：${def.models.map((item) => item.id).join('、')}）` }
    }
  }
  return resolveAgentModel({
    ...(modelDef?.input !== undefined ? { imageInput: modelDef.input.includes('image') } : {}),
    ...shared,
    apiKey,
    ...(def.baseUrl !== undefined ? { baseUrl: def.baseUrl } : {}),
    ...(def.api !== undefined ? { api: def.api } : {}),
    ...(modelDef?.name !== undefined ? { name: modelDef.name } : {}),
    ...(modelDef?.reasoning !== undefined ? { reasoning: modelDef.reasoning } : {}),
    ...(modelDef?.contextWindow !== undefined ? { contextWindow: modelDef.contextWindow } : {}),
    ...(modelDef?.maxTokens !== undefined ? { maxTokens: modelDef.maxTokens } : {}),
  })
}
