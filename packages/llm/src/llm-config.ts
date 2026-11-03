/**
 * 语言服务提供方（config.yaml 的 `llm.providers`）：形状照抄 pi 的 `models.json` 的一个子集。应用表的 `type: llm` 引用这张表的 key，带模型的提供方自动成为 text 类应用（`@learning/apps` 的 `llm-apps.ts`）。
 *
 * ```yaml
 * llm:
 *   providers:
 *     ollama:
 *       name: 本机 ollama
 *       baseUrl: http://127.0.0.1:11434/v1
 *       api: openai-completions
 *       apiKey: $OLLAMA_API_KEY
 *       models:
 *         - { id: deepseek-v4.1-flash:1017-cloud, name: DeepSeek V4.1 flash, input: [text, image], reasoning: true }
 * ```
 *
 * 这里**只校验形状**，不解析模型、不读环境变量、不认识 pi（`api` 认不认得、模型用不用得了在 `./llm-providers.ts`，那是「配置对但现在用不了」）。
 * 形状不对 = 拒绝启动：不认识的字段、类型不对、`apiKey` 写了明文、重复的模型 id、不合法的提供方 id。**报错不回显值**：里面可能有密钥。
 */

export type LlmModelInput = 'text' | 'image'

export interface LlmModelDef {
  /** 发给端点的模型 id */
  id: string
  /** 给人看的名字 */
  name?: string
  /** 吃什么输入；不写 = 按 pi 注册表，自建端点只吃文字 */
  input?: readonly LlmModelInput[]
  /** 支不支持思考；不写 = 按 pi 注册表，自建端点不支持 */
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
}

export interface LlmProviderDef {
  /** 给人看的名字 */
  name?: string
  /** 给了就是自建 / 代理端点；不写 = pi 内置提供方自己的地址 */
  baseUrl?: string
  /** 线协议；取值在解析模型时判 */
  api?: string
  /** `apiKey: $NAME` 引用的环境变量名；不写 = 按提供方退回它自己的环境变量 */
  apiKeyEnv?: string
  /** 这个提供方的模型；可以是空表（只换地址 / key，模型照 pi 注册表） */
  models: readonly LlmModelDef[]
}

export type LlmProviderTable = Readonly<Record<string, LlmProviderDef>>

/** 提供方 id：同应用表的 id（小写字母开头，小写字母、数字、`-`，最长 48） */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,47}$/
/** `apiKey` 只能是环境变量引用 */
const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/
const MODEL_INPUTS: readonly string[] = ['text', 'image']

const PROVIDER_FIELDS = ['name', 'baseUrl', 'api', 'apiKey', 'models']
const MODEL_FIELDS = ['id', 'name', 'input', 'reasoning', 'contextWindow', 'maxTokens']

const CONFIG_PATH = 'llm.providers'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 写了键没写值（YAML 里 `name:`）当没配 */
const present = (value: unknown) => value !== undefined && value !== null

function fail(message: string): never {
  throw new Error(`[config] ${message}`)
}

function assertKnownFields(value: Record<string, unknown>, known: readonly string[], at: string) {
  const unknown = Object.keys(value).filter((field) => !known.includes(field))
  if (unknown.length > 0) fail(`${at}：不认识的字段 ${unknown.join('、')}（只认 ${known.join(' / ')}）`)
}

function optionalString(value: Record<string, unknown>, field: string, at: string): string | undefined {
  const raw = value[field]
  if (!present(raw)) return undefined
  if (typeof raw !== 'string') fail(`${at}.${field} 必须是字符串`)
  return raw.trim() || undefined
}

function optionalPositiveInteger(value: Record<string, unknown>, field: string, at: string): number | undefined {
  const raw = value[field]
  if (!present(raw)) return undefined
  if (!(typeof raw === 'number' && Number.isInteger(raw) && raw > 0)) fail(`${at}.${field} 必须是正整数`)
  return raw
}

function parseModel(raw: unknown, at: string): LlmModelDef {
  if (!isRecord(raw)) fail(`${at} 必须是对象`)
  assertKnownFields(raw, MODEL_FIELDS, at)
  const id = optionalString(raw, 'id', at)
  if (!id) fail(`${at}：缺少 id`)
  const name = optionalString(raw, 'name', at)
  let input: LlmModelInput[] | undefined
  if (present(raw.input)) {
    const list = raw.input
    if (!Array.isArray(list) || list.length === 0 || list.some((item) => !MODEL_INPUTS.includes(item as string))) {
      fail(`${at}.input 必须是 ${MODEL_INPUTS.join(' / ')} 组成的非空数组`)
    }
    input = list as LlmModelInput[]
  }
  if (present(raw.reasoning) && typeof raw.reasoning !== 'boolean') fail(`${at}.reasoning 必须是 true / false`)
  const contextWindow = optionalPositiveInteger(raw, 'contextWindow', at)
  const maxTokens = optionalPositiveInteger(raw, 'maxTokens', at)
  return {
    id,
    ...(name ? { name } : {}),
    ...(input ? { input } : {}),
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  }
}

function parseProvider(raw: unknown, at: string): LlmProviderDef {
  if (!isRecord(raw)) fail(`${at} 必须是对象（${PROVIDER_FIELDS.join(' / ')}）`)
  assertKnownFields(raw, PROVIDER_FIELDS, at)
  const name = optionalString(raw, 'name', at)
  const baseUrl = optionalString(raw, 'baseUrl', at)
  if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) fail(`${at}.baseUrl 必须是 http(s) 地址`)
  const api = optionalString(raw, 'api', at)
  let apiKeyEnv: string | undefined
  if (present(raw.apiKey)) {
    const ref = typeof raw.apiKey === 'string' ? ENV_REF.exec(raw.apiKey.trim()) : null
    if (!ref) fail(`${at}.apiKey 只能写成 "$环境变量名"（密钥不进配置），不写则按提供方的环境变量`)
    apiKeyEnv = ref[1]
  }
  const models: LlmModelDef[] = []
  if (present(raw.models)) {
    if (!Array.isArray(raw.models)) fail(`${at}.models 必须是数组`)
    const seen = new Set<string>()
    raw.models.forEach((item, index) => {
      const model = parseModel(item, `${at}.models[${index}]`)
      if (seen.has(model.id)) fail(`${at}.models[${index}]：模型 id ${model.id} 重复`)
      seen.add(model.id)
      models.push(model)
    })
  }
  return {
    ...(name ? { name } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
    ...(api ? { api } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    models,
  }
}

/** 解析 `llm.providers`。没写 = 空表；形状不对抛错，带路径，不回显值 */
export function parseLlmProviders(value: unknown): LlmProviderTable {
  if (!present(value)) return {}
  if (!isRecord(value)) fail(`${CONFIG_PATH} 必须是对象（提供方 id → 提供方配置）`)
  const table: Record<string, LlmProviderDef> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!PROVIDER_ID.test(id)) fail(`${CONFIG_PATH} 的提供方 id 不合法：${id}（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    table[id] = parseProvider(raw, `${CONFIG_PATH}.${id}`)
  }
  return table
}
