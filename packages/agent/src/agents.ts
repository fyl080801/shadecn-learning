import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { LOAD_SKILL_TOOL_NAME, REQUEST_CONFIRMATION_TOOL_NAME, type SkillRegistry } from './skills/registry.ts'

/**
 * agent 定义（docs/26 §3.1）：一个 `.md` 文件，格式就是 pi 的 agent 配置（`@earendil-works/pi-coding-agent` 1.4 的
 * subagent 示例 `examples/extensions/subagent/agents.ts`）—— frontmatter `name` / `description` / `tools` / `model` + 正文（系统提示）。
 * pi 没有从包里导出这个类型、那个包也不引入，这里照抄同名同字段的 {@link AgentConfig}，不加自造字段。
 *
 * **只在服务端**：读文件用 `node:fs`，runner 一侧的模块永远不 import 这里（runner 的产物会把它连同 `yaml` 拖进沙箱）。
 * **本包不自己找目录**：定义随服务端产物发布，源码在 `packages/agent/agents/`、产物在 `output/server/agents/`，
 * 用哪个由宿主决定（apps/server `config.ts` 的 `agentDefinitionsDir`）—— 同 `model.ts` 不读 `process.env` 的分工。
 *
 * 和 pi 的加载器有意不同的地方：pi 在一个目录里扫用户自己的定义，坏文件静默跳过、`tools` 写坏了当「全部工具」；
 * 这里的定义随代码发布、启动时校验，**任何不对都抛错、服务起不来**（同 `createSkillRegistry`）——
 * 尤其不能把写坏 / 写空的白名单当成「全部」：那是悄悄放宽。
 */

/** 同 pi 的 `AgentConfig`（去掉了只对 pi 的「用户 / 项目」两种来源有意义的 `source`） */
export interface AgentConfig {
  /** agent 的 id：小写字母、数字、`-`。发布后不改 */
  name: string
  /** 一句话：进调用方的「可调用的 agent」目录（`run_agent` 的工具描述，docs/26 §3.5） */
  description: string
  /** 工具名白名单（docs/26 §3.3）；省略 = 全部。平台工具（`load_skill` / `request_confirmation`）不写在这里 */
  tools?: string[]
  /** 模型表的 key（docs/26 §3.4）；省略 = {@link DEFAULT_AGENT_MODEL} */
  model?: string
  /** 正文：这个 agent 的系统提示（位置见 `prompt.ts` 的 `systemPromptFor`） */
  systemPrompt: string
  /** 从哪个文件读的：报错时指出来 */
  filePath: string
}

/** 入口 agent（docs/26 §3.7）：会话固定用它，定义里必须有 */
export const ENTRY_AGENT_NAME = 'canvas'

/** 模型表里的默认项（P2～P3 只有它：`AGENT_PROVIDER` / `AGENT_MODEL` / … 配的那一个） */
export const DEFAULT_AGENT_MODEL = 'default'

const AGENT_NAME_REGEX = /^[a-z][a-z0-9-]{0,47}$/

const FRONTMATTER_KEYS = new Set(['name', 'description', 'tools', 'model'])

/** 同 pi 的 `extractFrontmatter`：去 BOM、统一换行，`---` 开头到下一个 `\n---` 是 YAML，之后的去掉首尾空白是正文 */
function extractFrontmatter(content: string): { yaml: string | null; body: string } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return { yaml: null, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { yaml: null, body: normalized }
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() }
}

/**
 * 同 pi 的 `parseToolList`：逗号分隔的字符串或 YAML 数组都认。不同的是写坏了（别的类型、数组里有非字符串、
 * 写了却是空的）一律抛错 —— pi 那边会退成 `undefined` = 全部工具
 */
function parseToolList(value: unknown, where: string): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (raw === null) throw new Error(`${where}：tools 只能是逗号分隔的字符串或 YAML 数组`)
  if (raw.some((item) => typeof item !== 'string')) throw new Error(`${where}：tools 里只能是工具名（字符串）`)
  const tools = (raw as string[]).map((item) => item.trim()).filter(Boolean)
  if (tools.length === 0) throw new Error(`${where}：tools 写了却是空的；要全部工具就省略 tools`)
  return tools
}

/** 解析一个定义文件。只做形状上的检查（frontmatter、字段类型）；名字、工具、模型、重名在 {@link createAgentRegistry} 里判 */
export function parseAgentConfig(text: string, filePath: string): AgentConfig {
  const where = `agent 定义 ${filePath}`
  const { yaml, body } = extractFrontmatter(text)
  if (yaml === null) throw new Error(`${where}：没有 frontmatter（文件要以 --- 开头，写 name / description）`)
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch (err) {
    throw new Error(`${where}：frontmatter 不是合法的 YAML：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  parsed ??= {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${where}：frontmatter 必须是键值对`)
  const fields = parsed as Record<string, unknown>
  // 不认识的键（多半是拼错的 tools / model）不放过：拼错的白名单会悄悄变成「全部工具」
  const unknown = Object.keys(fields).filter((key) => !FRONTMATTER_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${where}：不认识的字段 ${unknown.join('、')}（只认 name / description / tools / model）`)
  if (typeof fields.name !== 'string') throw new Error(`${where}：缺少 name（字符串）`)
  if (typeof fields.description !== 'string') throw new Error(`${where}：缺少 description（字符串）`)
  if (fields.model !== undefined && typeof fields.model !== 'string') throw new Error(`${where}：model 必须是字符串（模型表的 key）`)
  const tools = fields.tools === undefined || fields.tools === null ? undefined : parseToolList(fields.tools, where)
  return {
    name: fields.name,
    description: fields.description,
    ...(tools ? { tools } : {}),
    ...(typeof fields.model === 'string' ? { model: fields.model } : {}),
    systemPrompt: body,
    filePath,
  }
}

/** 读一个目录里的全部 `*.md`（按文件名排序）。目录读不到就抛：定义随代码发布，缺了是打包的错 */
export function loadAgentConfigs(dir: string): AgentConfig[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`读不到 agent 定义目录 ${dir}：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  return entries
    .filter((entry) => entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const filePath = path.join(dir, name)
      return parseAgentConfig(readFileSync(filePath, 'utf8'), filePath)
    })
}

/**
 * `tools` 里的每个名字都是技能注册表里某个技能的工具；平台工具不能写（它们是隐含的，写了也不该能「去掉」或「加上」）。
 * 建注册表时判一次；`createAgentRuntime` 拿它自己的技能注册表再判一次（测试可能换了注册表）
 */
export function assertAgentTools(config: AgentConfig, skills: SkillRegistry): void {
  const where = `agent 定义 ${config.filePath}`
  const seen = new Set<string>()
  for (const name of config.tools ?? []) {
    if (name === LOAD_SKILL_TOOL_NAME || name === REQUEST_CONFIRMATION_TOOL_NAME) {
      throw new Error(`${where}：tools 里不能写平台工具 ${name}（它不受白名单影响，不用写）`)
    }
    if (!skills.skillOfTool(name)) throw new Error(`${where}：tools 里的 ${name} 不是任何技能的工具`)
    if (seen.has(name)) throw new Error(`${where}：tools 里的 ${name} 写了两次`)
    seen.add(name)
  }
}

/** 这个 agent 的工具白名单；`null` = 没写 `tools`，全部 */
export function agentToolWhitelist(config: Pick<AgentConfig, 'tools'>): ReadonlySet<string> | null {
  return config.tools ? new Set(config.tools) : null
}

/** 这个 agent 用模型表里的哪一项 */
export function agentModelKey(config: Pick<AgentConfig, 'model'>): string {
  return config.model ?? DEFAULT_AGENT_MODEL
}

export interface AgentRegistry {
  /** 按加载顺序（文件名） */
  readonly agents: readonly AgentConfig[]
  get(name: string): AgentConfig | undefined
  /** 入口 agent（{@link ENTRY_AGENT_NAME}） */
  readonly entry: AgentConfig
}

export interface AgentRegistryOptions {
  /** 技能注册表：`tools` 里的名字按它判 */
  skills: SkillRegistry
  /** 模型表的 key（P2～P3 只有 {@link DEFAULT_AGENT_MODEL}，P4 起是模型表）：`model` 按它判 */
  models: readonly string[]
}

/**
 * 建 agent 注册表，并校验全部定义（docs/26 §3.1「启动时校验，错了就起不来」）：`name` 合法且不重复、有 `description`、
 * `tools` 里每个名字都是技能注册表里的工具（平台工具不能写）、`model` 在模型表里、必须有 `canvas`。违反任何一条都抛出，
 * 报错指出哪个文件哪个字段。
 */
export function createAgentRegistry(configs: readonly AgentConfig[], options: AgentRegistryOptions): AgentRegistry {
  const byName = new Map<string, AgentConfig>()
  for (const config of configs) {
    const where = `agent 定义 ${config.filePath}`
    if (!AGENT_NAME_REGEX.test(config.name)) {
      throw new Error(`${where}：name「${config.name}」不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    }
    const other = byName.get(config.name)
    if (other) throw new Error(`${where}：name「${config.name}」和 ${other.filePath} 重复`)
    if (config.description.trim() === '') throw new Error(`${where}：description 是空的`)
    assertAgentTools(config, options.skills)
    const model = agentModelKey(config)
    if (!options.models.includes(model)) {
      throw new Error(`${where}：model「${model}」不在模型表里（现有：${options.models.join('、') || '无'}）`)
    }
    byName.set(config.name, config)
  }
  const entry = byName.get(ENTRY_AGENT_NAME)
  if (!entry) throw new Error(`缺少入口 agent 的定义 ${ENTRY_AGENT_NAME}.md（name: ${ENTRY_AGENT_NAME}）`)
  return { agents: [...configs], get: (name) => byName.get(name), entry }
}
