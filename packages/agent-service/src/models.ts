import { readFileSync } from 'node:fs'
import { DEFAULT_AGENT_MODEL } from '@learning/agent-core/agents'
import { resolveProviderModel, type EnvReader, type ProviderTable } from '@learning/llm/llm-providers'
import { AGENT_THINKING_LEVELS, isAgentThinkingLevel, type AgentThinkingLevel, type ModelResolution } from '@learning/llm/model'
import type { AgentOptions } from './options.js'

/** 模型表里 `default` 以外的项（key → 解析结果），交给 `createAgentRuntime({ models })` */
export const AGENT_MODELS = Symbol('AGENT_MODELS')
export type AgentModels = Readonly<Record<string, ModelResolution>>

/**
 * 模型表（docs/26 §3.4）里 `default` 以外的项：读 `<dataDir>/agent-models.json`。`default` 来自 config.yaml 的 `agent.provider` / `agent.model` / `agent.thinking`。
 *
 * **每一项只选「哪个提供方的哪个模型」**：地址、key、模型能力都在 `llm.providers`。两类错误分开：
 * - **文件本身不对 → 拒绝启动**：不是合法 JSON、顶层不是对象、key 不合法、写了 `default`、不认识的字段（连接信息写回这里也算）、字段类型不对；
 * - **某一项用不了 → 不是启动错误**：解析结果记成不可用（带原因），到有 agent 用它时才报。
 */

export interface AgentModelSpec {
  provider: string
  model: string
  /** 请模型思考的等级；不写 = 不请求 */
  thinking?: AgentThinkingLevel
}

/** 模型表的 key：同 agent 定义的 `name` */
const MODEL_KEY_REGEX = /^[a-z][a-z0-9-]{0,47}$/

const KNOWN_FIELDS: readonly string[] = ['provider', 'model', 'thinking']
const FIELD_LIST = 'provider / model / thinking'
/** 这些字段在 `llm.providers`：单独报，告诉人该写到哪（不回显值：`apiKey` 可能是明文） */
const CONNECTION_FIELDS: readonly string[] = ['baseUrl', 'api', 'apiKey', 'imageInput', 'contextWindow', 'maxTokens']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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
    if (key === DEFAULT_AGENT_MODEL) throw new Error(`${at}：${DEFAULT_AGENT_MODEL} 不能写在文件里，它来自 config.yaml 的 agent.provider / agent.model`)
    if (!MODEL_KEY_REGEX.test(key)) throw new Error(`${at}：key 不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    if (!isRecord(value)) throw new Error(`${at}：必须是对象（${FIELD_LIST}）`)
    const connection = Object.keys(value).filter((field) => CONNECTION_FIELDS.includes(field))
    if (connection.length > 0) throw new Error(`${at}：${connection.join('、')} 不写在模型表里 —— 连接信息在 llm.providers（docs/26 §3.4），这里只认 ${FIELD_LIST}`)
    const unknown = Object.keys(value).filter((field) => !KNOWN_FIELDS.includes(field))
    if (unknown.length > 0) throw new Error(`${at}：不认识的字段 ${unknown.join('、')}（只认 ${FIELD_LIST}）`)
    for (const field of ['provider', 'model'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`${at}：${field} 必须是字符串`)
    }
    if (value.thinking !== undefined && !isAgentThinkingLevel(value.thinking)) throw new Error(`${at}：thinking 只能是 ${AGENT_THINKING_LEVELS.join(' / ')}`)
    const provider = (value.provider as string | undefined)?.trim() ?? ''
    const model = (value.model as string | undefined)?.trim() ?? ''
    if (!provider) throw new Error(`${at}：缺少 provider`)
    if (!model) throw new Error(`${at}：缺少 model`)
    table[key] = { provider, model, ...(isAgentThinkingLevel(value.thinking) ? { thinking: value.thinking } : {}) }
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

/** 每一项解析成模型（和 `default` 同一条路）。用不了的项是 `{ ok: false, reason }`，不抛 */
export function resolveAgentModelTable(specs: Readonly<Record<string, AgentModelSpec>>, options: { table: ProviderTable; envVar: EnvReader }): Record<string, ModelResolution> {
  const table: Record<string, ModelResolution> = {}
  for (const [key, spec] of Object.entries(specs)) {
    table[key] = resolveProviderModel({
      table: options.table,
      provider: spec.provider,
      model: spec.model,
      envVar: options.envVar,
      ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
    })
  }
  return table
}

/** `AGENT_MODELS` 的工厂：文件坏了打一行 `[agent]` 错误、抛出（服务起不来）；用不了的项各打一行警告 */
export function loadAgentModels(options: AgentOptions): AgentModels {
  let specs: Record<string, AgentModelSpec>
  try {
    specs = loadAgentModelTable(options.modelsFile)
  } catch (err) {
    console.error(`[agent] 模型表不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  const table = resolveAgentModelTable(specs, { table: options.llmProviders, envVar: options.envVar })
  for (const [key, resolution] of Object.entries(table)) {
    if (!resolution.ok) console.warn(`[agent] 模型表的「${key}」现在不可用（用它的 agent 到时会报错）：${resolution.reason}`)
  }
  const keys = Object.keys(table)
  if (keys.length > 0) console.info(`[agent] 模型表（${options.modelsFile}）：${DEFAULT_AGENT_MODEL}、${keys.join('、')}`)
  return table
}
