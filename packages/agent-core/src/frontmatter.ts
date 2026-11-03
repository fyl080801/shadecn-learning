import { parse as parseYaml } from 'yaml'

/**
 * 随代码发布的 Markdown 配置（agent 定义 `agents.ts`、文字技能 `text-skills.ts`）共用的 frontmatter 读法。
 * **只在服务端**：`yaml` 不能进沙箱，runner 一侧的模块永远不 import 这里。
 */

/** 同 pi 的 `extractFrontmatter`：去 BOM、统一换行，`---` 开头到下一个 `\n---` 是 YAML，之后的去掉首尾空白是正文 */
function extractFrontmatter(content: string): { yaml: string | null; body: string } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return { yaml: null, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { yaml: null, body: normalized }
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() }
}

/**
 * 读出 frontmatter 的键值和正文。没有 frontmatter、YAML 坏了、不是键值对都抛错（`where` 指出哪个文件）；
 * 字段本身的检查交给调用方
 */
export function readFrontmatter(text: string, where: string): { fields: Record<string, unknown>; body: string } {
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
  return { fields: parsed as Record<string, unknown>, body }
}
