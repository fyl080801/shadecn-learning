import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { AGENT_SKILL_ID_ALIASES, type AgentSkillId } from '@shadecn/shared/agent'
import { AGENT_NAME_REGEX } from './agents.ts'
import { readFrontmatter } from './frontmatter.ts'
import type { SkillRegistry } from './skills/registry.ts'

/**
 * 文字技能（docs/26 §3.8、docs/23 §7）：pi / Agent Skills 标准的 `SKILL.md` —— frontmatter `name` / `description` / 可选 `requires`
 * （依赖的**内置**技能 id）+ 正文（指令）。**只有文字，不带代码、不新增工具**；加载时依赖的内置技能一起加载（`session.ts`）。
 *
 * **只在服务端**：读文件用 `node:fs` + `yaml`，runner 一侧的模块永远不 import 这里。runner 也永远不认识文字技能：
 * 它们不在 {@link SkillRegistry} 里（那份两侧共用、只有内置技能），网关回给 runner 的 `loadedSkills` 只有内置技能 id。
 * **本包不自己找目录**（同 `agents.ts`）：源码在 `packages/agent/skills/`、产物在 `output/server/skills/`，由宿主传（apps/server `config.ts` 的 `agentTextSkillsDir`）。
 *
 * ## 目录里哪些文件算技能（同 pi 的 `loadSkillsFromDir`，少了 `.gitignore` 规则）
 *
 * - 一个子目录里有 `SKILL.md` → 它就是一个技能，不再往下找（技能目录里别的文件不读）；没有就接着往它的子目录里找 `SKILL.md`；
 * - 根目录下直接放的 `*.md` 也各算一个技能；**根目录的 `README.md`（不分大小写）不算**，它是说明这个目录的文档；
 * - 以 `.` 开头的、`node_modules` 跳过；子目录里不是 `SKILL.md` 的 `.md` 不读；
 * - 目录不存在 = 没有文字技能（不是错误）。
 *
 * ## 和 pi 的加载器有意不同的地方
 *
 * pi 把有问题的技能记成诊断、照样（或静默跳过）加载；这里随代码发布、启动时校验，**任何不对都抛错、服务起不来**（同 agent 定义）：
 * 不认识的 frontmatter 键（含 pi 的 `disable-model-invocation`：这里没有斜杠命令，只能由模型 `load_skill`）、缺 `description`、正文为空、
 * `name` 不合法 / 重复 / 和内置技能 id 或它们的旧 id 撞、`requires` 写了不存在的内置技能或文字技能。
 * `SKILL.md` 的 `name` 必须和它所在的目录同名（Agent Skills 标准的要求；pi 1.4 不查）。
 */

export interface TextSkill {
  /** 技能 id：`load_skill` 的参数、会话记住的就是它。规则同 agent 名（小写字母开头，小写字母、数字、`-`，最长 48），发布后不改 */
  name: string
  /** 一句话：进技能目录，模型据此判断要不要加载 */
  description: string
  /** 依赖的内置技能 id（加载它时一起加载）；没写 = 空 */
  requires: AgentSkillId[]
  /** 正文：加载后进上下文的指令 */
  body: string
  /** 从哪个文件读的：报错时指出来 */
  filePath: string
}

/** 文字技能的文件名（技能目录里的那一个） */
export const TEXT_SKILL_FILE = 'SKILL.md'

/** `description` 的长度上限（Agent Skills 标准）：它每一轮都进系统提示的技能目录 */
export const TEXT_SKILL_DESCRIPTION_LIMIT = 1024

const FRONTMATTER_KEYS = new Set(['name', 'description', 'requires'])

/** 同 agent 定义的 `tools`：逗号分隔的字符串或 YAML 数组都认；写坏、写空、写重了一律抛错 */
function parseRequires(value: unknown, where: string): AgentSkillId[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (raw === null) throw new Error(`${where}：requires 只能是逗号分隔的字符串或 YAML 数组（内置技能 id）`)
  if (raw.some((item) => typeof item !== 'string')) throw new Error(`${where}：requires 里只能是内置技能 id（字符串）`)
  const ids = (raw as string[]).map((item) => item.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error(`${where}：requires 写了却是空的；没有依赖就省略 requires`)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) throw new Error(`${where}：requires 里的 ${duplicate} 写了两次`)
  return ids
}

/**
 * 解析一个文字技能文件。只做这个文件自己能判的检查（frontmatter、字段类型、正文、`SKILL.md` 与目录同名）；
 * 名字规则、重名、和内置技能的关系在 {@link createTextSkillRegistry} 里判
 */
export function parseTextSkill(text: string, filePath: string): TextSkill {
  const where = `文字技能 ${filePath}`
  const { fields, body } = readFrontmatter(text, where)
  if ('disable-model-invocation' in fields) {
    throw new Error(`${where}：不支持 disable-model-invocation（这里没有斜杠命令，文字技能只能由模型 load_skill 加载）`)
  }
  const unknown = Object.keys(fields).filter((key) => !FRONTMATTER_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${where}：不认识的字段 ${unknown.join('、')}（只认 name / description / requires）`)
  if (typeof fields.name !== 'string') throw new Error(`${where}：缺少 name（字符串）`)
  if (typeof fields.description !== 'string' || fields.description.trim() === '') {
    throw new Error(`${where}：缺少 description（一句话，进技能目录）`)
  }
  if (fields.description.length > TEXT_SKILL_DESCRIPTION_LIMIT) {
    throw new Error(`${where}：description 超过 ${TEXT_SKILL_DESCRIPTION_LIMIT} 字（它每一轮都进系统提示）`)
  }
  if (path.basename(filePath) === TEXT_SKILL_FILE) {
    const dirName = path.basename(path.dirname(filePath))
    if (fields.name !== dirName) throw new Error(`${where}：name「${fields.name}」要和所在目录同名（${dirName}）`)
  }
  if (body === '') throw new Error(`${where}：正文是空的（文字技能的内容就是正文里的指令）`)
  const requires = fields.requires === undefined || fields.requires === null ? [] : parseRequires(fields.requires, where)
  return { name: fields.name, description: fields.description.trim(), requires, body, filePath }
}

/** 跟着符号链接判类型；坏链接当不存在 */
function kindOf(dir: string, entry: Dirent): 'file' | 'dir' | null {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  if (!entry.isSymbolicLink()) return null
  try {
    const stats = statSync(path.join(dir, entry.name))
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : null
  } catch {
    return null
  }
}

function listDir(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 一个子目录：有 `SKILL.md` 就是一个技能、不再往下；没有就往它的子目录里找 */
function collectFromSubdir(dir: string, files: string[]): void {
  const entries = listDir(dir)
  const skillFile = entries.find((entry) => entry.name === TEXT_SKILL_FILE && kindOf(dir, entry) === 'file')
  if (skillFile) {
    files.push(path.join(dir, skillFile.name))
    return
  }
  for (const entry of entries) if (kindOf(dir, entry) === 'dir') collectFromSubdir(path.join(dir, entry.name), files)
}

/** 根目录的这个文件是不是说明文档（不是技能） */
export function isTextSkillsReadme(fileName: string): boolean {
  return fileName.toLowerCase() === 'readme.md'
}

/**
 * 按上面的规则找出目录里的全部文字技能文件并解析（顺序：按名字排，子目录深度优先 —— 也是技能目录里的顺序）。
 * 目录不存在 = 没有文字技能；读得到却读坏了（不是目录、没权限）、任何一个文件不合法都抛
 */
export function loadTextSkills(dir: string): TextSkill[] {
  let entries: Dirent[]
  try {
    entries = listDir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`读不到文字技能目录 ${dir}：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  const files: string[] = []
  for (const entry of entries) {
    const kind = kindOf(dir, entry)
    if (kind === 'dir') {
      collectFromSubdir(path.join(dir, entry.name), files)
    } else if (kind === 'file' && entry.name.endsWith('.md')) {
      if (isTextSkillsReadme(entry.name)) continue
      if (entry.name === TEXT_SKILL_FILE) {
        throw new Error(`文字技能目录 ${dir} 的根上不能直接放 ${TEXT_SKILL_FILE}：每个技能一个子目录（<name>/${TEXT_SKILL_FILE}），或根上的 <name>.md`)
      }
      files.push(path.join(dir, entry.name))
    }
  }
  return files.map((filePath) => parseTextSkill(readFileSync(filePath, 'utf8'), filePath))
}

export interface TextSkillRegistry {
  /** 按加载顺序 = 技能目录里的顺序（排在内置技能后面） */
  readonly skills: readonly TextSkill[]
  get(name: string): TextSkill | undefined
}

/** 没有文字技能 */
export const NO_TEXT_SKILLS: TextSkillRegistry = { skills: [], get: () => undefined }

/**
 * 建文字技能注册表并校验（docs/26 §3.8「启动时校验」）：`name` 合法且不重复、不和内置技能 id 撞、不和内置技能的旧 id
 * （`AGENT_SKILL_ID_ALIASES`：会话里存着的旧 id 读出时会被换掉）撞；`requires` 里每个都是现在的内置技能 id ——
 * 不能是旧 id、不能是文字技能。违反任何一条都抛出，指出哪个文件哪个字段。
 * `createAgentRuntime` 拿它自己的技能注册表再建一次（测试可能换了注册表）
 */
export function createTextSkillRegistry(skills: readonly TextSkill[], options: { skills: SkillRegistry }): TextSkillRegistry {
  const byName = new Map<string, TextSkill>()
  for (const skill of skills) {
    const where = `文字技能 ${skill.filePath}`
    if (!AGENT_NAME_REGEX.test(skill.name)) {
      throw new Error(`${where}：name「${skill.name}」不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    }
    const other = byName.get(skill.name)
    if (other) throw new Error(`${where}：name「${skill.name}」和 ${other.filePath} 重复`)
    if (options.skills.get(skill.name)) throw new Error(`${where}：name「${skill.name}」和内置技能重名`)
    const alias = AGENT_SKILL_ID_ALIASES.get(skill.name)
    if (alias !== undefined) throw new Error(`${where}：name「${skill.name}」是内置技能 ${alias} 的旧 id，不能用`)
    byName.set(skill.name, skill)
  }
  for (const skill of skills) {
    const where = `文字技能 ${skill.filePath}`
    for (const id of skill.requires) {
      if (options.skills.get(id)) continue
      const alias = AGENT_SKILL_ID_ALIASES.get(id)
      if (alias !== undefined) throw new Error(`${where}：requires 里的 ${id} 是旧 id，写 ${alias}`)
      if (byName.has(id)) throw new Error(`${where}：requires 里的 ${id} 是文字技能；只能依赖内置技能`)
      throw new Error(`${where}：requires 里的 ${id} 不是内置技能（现有：${options.skills.skills.map((item) => item.id).join('、')}）`)
    }
  }
  return { skills: [...skills], get: (name) => byName.get(name) }
}
