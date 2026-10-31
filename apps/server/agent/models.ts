import { readFileSync } from 'node:fs'
import { DEFAULT_AGENT_MODEL } from '@shadecn/agent/agents'
import {
  AGENT_THINKING_LEVELS,
  isAgentThinkingLevel,
  resolveAgentModel,
  type AgentModelOptions,
  type AgentThinkingLevel,
  type ModelResolution,
} from '@shadecn/agent/model'
import { agentModelsFile, agentProviderApiKey } from '../config.ts'

/**
 * 模型表（docs/26 §3.4）里 `default` 以外的项：读 {@link agentModelsFile}（默认 `<dataDir>/agent-models.json`，`AGENT_MODELS_FILE` 可换）。
 * `default` 照旧来自 `AGENT_PROVIDER` / `AGENT_MODEL` / …（`config.ts` 的 `agentConfig`，在 `agent/index.ts` 里解析）。
 *
 * ```json
 * { "fast":   { "provider": "anthropic", "model": "claude-haiku-5-5", "apiKey": "$AGENT_FAST_KEY" },
 *   "vision": { "provider": "my-proxy", "model": "qwen-vl", "baseUrl": "https://…", "api": "openai-completions",
 *               "apiKey": "$AGENT_VISION_KEY", "imageInput": true, "contextWindow": 32768, "maxTokens": 4096, "thinking": "low" } }
 * ```
 *
 * 解析文件、读环境变量是宿主的事（`@shadecn/agent/model` 只收显式的参数对象）。两类错误分开：
 * - **文件本身不对 → 启动失败**（同 agent 定义，`definitions.ts` 在 import 时就读它）：不是合法 JSON、顶层不是对象、key 不合法、
 *   写了 `default`、不认识的字段、字段类型不对、`apiKey` 写了明文（**只认 `"$环境变量名"`**：密钥不进文件）；
 *   定义里引用了表里没有的 key 由 `createAgentRegistry` 判，同样起不来；
 * - **某一项用不了 → 不是启动错误**：`$ENV` 引用的变量没设 / 为空、pi 注册表里没有、线协议不支持……解析结果记成不可用（带原因），
 *   启动时打一行 `[agent]` 警告；到有 agent 用它时才报（入口 agent 的 = 这一轮不开始，被调用的 = 那次 `run_agent` 返回错误）。
 * 不写 `apiKey` = 同 `default` 的退回规则：按提供方自己的环境变量（`config.ts` 的 `AGENT_PROVIDER_KEY_ENV`）。
 */

/** 文件里的一项（`apiKey` 还是 `$NAME` 引用，没解析） */
export interface AgentModelSpec {
  provider: string
  model: string
  baseUrl?: string
  api?: string
  /** 环境变量名（文件里写 `"$NAME"`）；不写 = 按提供方退回 */
  apiKeyEnv?: string
  imageInput?: boolean
  /** 上下文窗口 / 单次最多输出（正整数）；不写 = 按注册表元数据，自建端点按保守默认（同 `default` 的 `AGENT_CONTEXT_WINDOW` / `AGENT_MAX_TOKENS`） */
  contextWindow?: number
  maxTokens?: number
  /** 请模型思考的等级；不写 = 不请求（同 `default` 的 `AGENT_THINKING`） */
  thinking?: AgentThinkingLevel
}

/** 模型表的 key：同 agent 定义的 `name`（小写字母开头，小写字母、数字、`-`） */
const MODEL_KEY_REGEX = /^[a-z][a-z0-9-]{0,47}$/
/** `apiKey` 只能是环境变量引用 */
const ENV_REF_REGEX = /^\$([A-Za-z_][A-Za-z0-9_]*)$/

const STRING_FIELDS = ['provider', 'model', 'baseUrl', 'api', 'apiKey'] as const
const INTEGER_FIELDS = ['contextWindow', 'maxTokens'] as const
const KNOWN_FIELDS = new Set<string>([...STRING_FIELDS, 'imageInput', ...INTEGER_FIELDS, 'thinking'])
const FIELD_LIST = 'provider / model / baseUrl / api / apiKey / imageInput / contextWindow / maxTokens / thinking'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析模型表文件的内容；任何不对都抛错（指出文件和 key / 字段）。只做形状校验，不解析模型、不读环境变量 */
export function parseAgentModelTable(text: string, filePath: string): Record<string, AgentModelSpec> {
  const where = `模型表 ${filePath}`
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${where}：不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (!isRecord(parsed)) throw new Error(`${where}：顶层必须是对象（key → 模型配置）`)
  const table: Record<string, AgentModelSpec> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const at = `${where} 的「${key}」`
    if (key === DEFAULT_AGENT_MODEL) {
      throw new Error(`${at}：${DEFAULT_AGENT_MODEL} 不能写在文件里，它来自 AGENT_PROVIDER / AGENT_MODEL / AGENT_BASE_URL / AGENT_API / AGENT_API_KEY`)
    }
    if (!MODEL_KEY_REGEX.test(key)) throw new Error(`${at}：key 不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    if (!isRecord(value)) throw new Error(`${at}：必须是对象（${FIELD_LIST}）`)
    const unknown = Object.keys(value).filter((field) => !KNOWN_FIELDS.has(field))
    if (unknown.length > 0) {
      throw new Error(`${at}：不认识的字段 ${unknown.join('、')}（只认 ${FIELD_LIST}）`)
    }
    for (const field of STRING_FIELDS) {
      if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`${at}：${field} 必须是字符串`)
    }
    if (value.imageInput !== undefined && typeof value.imageInput !== 'boolean') throw new Error(`${at}：imageInput 必须是 true / false`)
    for (const field of INTEGER_FIELDS) {
      const raw = value[field]
      if (raw !== undefined && !(typeof raw === 'number' && Number.isInteger(raw) && raw > 0)) throw new Error(`${at}：${field} 必须是正整数`)
    }
    if (value.thinking !== undefined && !isAgentThinkingLevel(value.thinking)) {
      throw new Error(`${at}：thinking 只能是 ${AGENT_THINKING_LEVELS.join(' / ')}`)
    }
    const provider = (value.provider as string | undefined)?.trim() ?? ''
    const model = (value.model as string | undefined)?.trim() ?? ''
    if (!provider) throw new Error(`${at}：缺少 provider`)
    if (!model) throw new Error(`${at}：缺少 model`)
    let apiKeyEnv: string | undefined
    if (value.apiKey !== undefined) {
      const ref = ENV_REF_REGEX.exec((value.apiKey as string).trim())
      // 不把写错的值打进报错：它可能就是一把明文 key
      if (!ref) throw new Error(`${at}：apiKey 只能写成 "$环境变量名"（密钥不进文件），不写则按提供方的环境变量`)
      apiKeyEnv = ref[1]!
    }
    table[key] = {
      provider,
      model,
      ...(typeof value.baseUrl === 'string' && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
      ...(typeof value.api === 'string' && value.api.trim() ? { api: value.api.trim() } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(typeof value.imageInput === 'boolean' ? { imageInput: value.imageInput } : {}),
      ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
      ...(typeof value.maxTokens === 'number' ? { maxTokens: value.maxTokens } : {}),
      ...(isAgentThinkingLevel(value.thinking) ? { thinking: value.thinking } : {}),
    }
  }
  return table
}

/** 读模型表文件：不存在 = 空表（只有 `default`）；读得到却不合法就抛 */
export function loadAgentModelTable(filePath: string): Record<string, AgentModelSpec> {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`读不到模型表 ${filePath}：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  return parseAgentModelTable(text, filePath)
}

/**
 * 每一项解析成模型（同 `default` 的解析：`resolveAgentModel`）：`$ENV` 换成环境变量的值，没写 `apiKey` 按提供方的环境变量退回。
 * 用不了的项是 `{ ok: false, reason }`，不抛 —— 不可用不是启动错误（见文件头）
 */
export function resolveAgentModelTable(
  specs: Readonly<Record<string, AgentModelSpec>>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ModelResolution> {
  const table: Record<string, ModelResolution> = {}
  for (const [key, spec] of Object.entries(specs)) {
    let apiKey: string
    if (spec.apiKeyEnv !== undefined) {
      apiKey = env[spec.apiKeyEnv]?.trim() ?? ''
      if (!apiKey) {
        table[key] = { ok: false, reason: `apiKey 引用的环境变量 ${spec.apiKeyEnv} 没有设置` }
        continue
      }
    } else {
      apiKey = agentProviderApiKey(spec.provider, env)
    }
    const options: AgentModelOptions = {
      provider: spec.provider,
      model: spec.model,
      ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
      ...(spec.api !== undefined ? { api: spec.api } : {}),
      apiKey,
      ...(spec.imageInput !== undefined ? { imageInput: spec.imageInput } : {}),
      ...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
    }
    table[key] = resolveAgentModel(options)
  }
  return table
}

/** 启动时读一次：文件坏了打一行 `[agent]` 错误、抛出（服务起不来）；用不了的项各打一行警告 */
function loadAgentModels(): Record<string, ModelResolution> {
  let specs: Record<string, AgentModelSpec>
  try {
    specs = loadAgentModelTable(agentModelsFile)
  } catch (err) {
    console.error(`[agent] 模型表不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  const table = resolveAgentModelTable(specs)
  for (const [key, resolution] of Object.entries(table)) {
    if (!resolution.ok) console.warn(`[agent] 模型表的「${key}」现在不可用（用它的 agent 到时会报错）：${resolution.reason}`)
  }
  const keys = Object.keys(table)
  if (keys.length > 0) console.info(`[agent] 模型表（${agentModelsFile}）：${DEFAULT_AGENT_MODEL}、${keys.join('、')}`)
  return table
}

/** 模型表里 `default` 以外的项（key → 解析结果），交给 `createAgentRuntime({ models })` */
export const agentModels: Readonly<Record<string, ModelResolution>> = loadAgentModels()

/** 模型表的全部 key（含 `default`）：agent 定义的 `model` 按它校验 */
export const agentModelKeys: readonly string[] = [DEFAULT_AGENT_MODEL, ...Object.keys(agentModels)]
