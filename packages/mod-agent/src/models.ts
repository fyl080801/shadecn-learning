import { readFileSync } from 'node:fs'
import { DEFAULT_AGENT_MODEL } from '@shadecn/agent/agents'
import { resolveProviderModel, type EnvReader, type ProviderTable } from '@shadecn/agent/llm-providers'
import {
  AGENT_THINKING_LEVELS,
  isAgentThinkingLevel,
  type AgentThinkingLevel,
  type ModelResolution,
} from '@shadecn/agent/model'
import { agentEnv } from './config.ts'
import { agentPorts, lazySingleton } from './ports.ts'

/**
 * 模型表（docs/26 §3.4）里 `default` 以外的项：读 {@link agentModelsFile}（默认 `<dataDir>/agent-models.json`，`MODULES_AGENT_MODELS_FILE` 可换）。
 * `default` 来自 `MODULES_AGENT_PROVIDER` / `MODULES_AGENT_MODEL` / `MODULES_AGENT_THINKING`（`config.ts` 的 `agentConfig`，在 `agent/index.ts` 里解析）。
 *
 * ```json
 * { "fast":   { "provider": "anthropic", "model": "claude-haiku-5-5" },
 *   "vision": { "provider": "my-proxy", "model": "qwen-vl", "thinking": "low" } }
 * ```
 *
 * **每一项只选「哪个提供方的哪个模型」**：`provider` 引用 `llm.providers` 的 key（或 pi 的内置提供方），地址、key、模型能力都在那边，
 * 和 `default`、应用表的 `llm` 驱动走同一条解析（`@shadecn/agent/llm-providers` 的 `resolveProviderModel`）。两类错误分开：
 * - **文件本身不对 → 启动失败**（同 agent 定义，`definitions.ts` 在 import 时就读它）：不是合法 JSON、顶层不是对象、key 不合法、
 *   写了 `default`、不认识的字段（连接信息写回这里也算，报错指向 `llm.providers`）、字段类型不对；
 *   定义里引用了表里没有的 key 由 `createAgentRegistry` 判，同样起不来；
 * - **某一项用不了 → 不是启动错误**：`$ENV` 引用的变量没设 / 为空、pi 注册表里没有、线协议不支持……解析结果记成不可用（带原因），
 *   启动时打一行 `[agent]` 警告；到有 agent 用它时才报（入口 agent 的 = 这一轮不开始，被调用的 = 那次 `run_agent` 返回错误）。
 */

/** 文件里的一项 */
export interface AgentModelSpec {
  provider: string
  model: string
  /** 请模型思考的等级；不写 = 不请求（同 `default` 的 `MODULES_AGENT_THINKING`） */
  thinking?: AgentThinkingLevel
}

/** 模型表的 key：同 agent 定义的 `name`（小写字母开头，小写字母、数字、`-`） */
const MODEL_KEY_REGEX = /^[a-z][a-z0-9-]{0,47}$/

const KNOWN_FIELDS = new Set<string>(['provider', 'model', 'thinking'])
const FIELD_LIST = 'provider / model / thinking'
/** 这些字段搬去了 `llm.providers`：单独报，告诉人该写到哪（不回显值：`apiKey` 可能是明文） */
const CONNECTION_FIELDS = new Set<string>(['baseUrl', 'api', 'apiKey', 'imageInput', 'contextWindow', 'maxTokens'])

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
      throw new Error(`${at}：${DEFAULT_AGENT_MODEL} 不能写在文件里，它来自 ${agentEnv('provider')} / ${agentEnv('model')}`)
    }
    if (!MODEL_KEY_REGEX.test(key)) throw new Error(`${at}：key 不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    if (!isRecord(value)) throw new Error(`${at}：必须是对象（${FIELD_LIST}）`)
    const connection = Object.keys(value).filter((field) => CONNECTION_FIELDS.has(field))
    if (connection.length > 0) {
      throw new Error(`${at}：${connection.join('、')} 不写在模型表里 —— 连接信息在 llm.providers（docs/26 §3.4），这里只认 ${FIELD_LIST}`)
    }
    const unknown = Object.keys(value).filter((field) => !KNOWN_FIELDS.has(field))
    if (unknown.length > 0) {
      throw new Error(`${at}：不认识的字段 ${unknown.join('、')}（只认 ${FIELD_LIST}）`)
    }
    for (const field of ['provider', 'model'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`${at}：${field} 必须是字符串`)
    }
    if (value.thinking !== undefined && !isAgentThinkingLevel(value.thinking)) {
      throw new Error(`${at}：thinking 只能是 ${AGENT_THINKING_LEVELS.join(' / ')}`)
    }
    const provider = (value.provider as string | undefined)?.trim() ?? ''
    const model = (value.model as string | undefined)?.trim() ?? ''
    if (!provider) throw new Error(`${at}：缺少 provider`)
    if (!model) throw new Error(`${at}：缺少 model`)
    table[key] = {
      provider,
      model,
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
 * 每一项解析成模型（和 `default` 同一条路：`resolveProviderModel`）。用不了的项是 `{ ok: false, reason }`，不抛 —— 不可用不是启动错误（见文件头）。
 * 提供方表和环境变量没给就经端口读（测试直接给）
 */
export function resolveAgentModelTable(
  specs: Readonly<Record<string, AgentModelSpec>>,
  options: { table?: ProviderTable; envVar?: EnvReader } = {},
): Record<string, ModelResolution> {
  const providers = options.table ?? agentPorts().llmProviders
  const envVar = options.envVar ?? agentPorts().envVar
  const table: Record<string, ModelResolution> = {}
  for (const [key, spec] of Object.entries(specs)) {
    table[key] = resolveProviderModel({
      table: providers,
      provider: spec.provider,
      model: spec.model,
      envVar,
      ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
    })
  }
  return table
}

/** 启动时读一次：文件坏了打一行 `[agent]` 错误、抛出（服务起不来）；用不了的项各打一行警告 */
function loadAgentModels(): Record<string, ModelResolution> {
  let specs: Record<string, AgentModelSpec>
  try {
    specs = loadAgentModelTable(agentPorts().paths.modelsFile)
  } catch (err) {
    console.error(`[agent] 模型表不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  const table = resolveAgentModelTable(specs)
  for (const [key, resolution] of Object.entries(table)) {
    if (!resolution.ok) console.warn(`[agent] 模型表的「${key}」现在不可用（用它的 agent 到时会报错）：${resolution.reason}`)
  }
  const keys = Object.keys(table)
  if (keys.length > 0) console.info(`[agent] 模型表（${agentPorts().paths.modelsFile}）：${DEFAULT_AGENT_MODEL}、${keys.join('、')}`)
  return table
}

/** 模型表里 `default` 以外的项（key → 解析结果），交给 `createAgentRuntime({ models })` */
export const agentModels: Readonly<Record<string, ModelResolution>> = lazySingleton(loadAgentModels)

/** 模型表的全部 key（含 `default`）：agent 定义的 `model` 按它校验 */
export const agentModelKeys: readonly string[] = lazySingleton(() => [DEFAULT_AGENT_MODEL, ...Object.keys(agentModels)])
