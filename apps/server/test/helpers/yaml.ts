/**
 * 读 `k8s/` 下清单用的**极小** YAML 子集解析器（测试专用；仓库不为测试加 YAML 依赖）。
 *
 * 认得：`---` 分隔的多文档、`#` 注释（引号外）、按缩进的块状映射与序列（含 `- key: value` 起头的映射、
 * 和键同一缩进的序列）、单 / 双引号标量、`[a, 'b']` 与 `{}` / `{ k: v }` 这种不嵌套的流式写法、
 * `true` / `false` / `null` / 整数。**不认得**（遇到就抛，免得静默解析错）：块标量 `|` / `>`、锚点 / 别名、嵌套的流式结构。
 * 清单写进 `k8s/` 时守住这个子集即可（现有的几份都在里面）。
 */

interface Line {
  indent: number
  text: string
  no: number
}

export function parseYamlDocuments(source: string): unknown[] {
  const docs: Line[][] = [[]]
  source.split('\n').forEach((raw, index) => {
    if (/^---\s*$/.test(raw)) {
      docs.push([])
      return
    }
    const text = stripComment(raw).replace(/\s+$/, '')
    if (!text.trim()) return
    if (raw.includes('\t')) throw new Error(`第 ${index + 1} 行：不认制表符缩进`)
    const indent = text.length - text.trimStart().length
    docs.at(-1)!.push({ indent, text: text.trimStart(), no: index + 1 })
  })
  return docs
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const [value, next] = parseNode(lines, 0, lines[0]!.indent)
      if (next !== lines.length) throw new Error(`第 ${lines[next]!.no} 行：缩进对不上`)
      return value
    })
}

function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i)
    }
  }
  return line
}

const isDash = (text: string) => text === '-' || text.startsWith('- ')

function parseNode(lines: Line[], i: number, indent: number): [unknown, number] {
  return isDash(lines[i]!.text) ? parseSeq(lines, i, indent) : parseMap(lines, i, indent)
}

function parseSeq(lines: Line[], i: number, indent: number): [unknown[], number] {
  const items: unknown[] = []
  while (i < lines.length && lines[i]!.indent === indent && isDash(lines[i]!.text)) {
    const line = lines[i]!
    const rest = line.text.slice(1).trimStart()
    if (!rest) {
      const next = lines[i + 1]
      if (!next || next.indent <= indent) {
        items.push(null)
        i += 1
        continue
      }
      const [value, after] = parseNode(lines, i + 1, next.indent)
      items.push(value)
      i = after
    } else if (splitKey(rest)) {
      // `- key: value`：后面同一列上的键属于同一个映射 —— 把这一行改写成从那一列开始的映射行
      const column = indent + (line.text.length - rest.length)
      const virtual = [...lines]
      virtual[i] = { indent: column, text: rest, no: line.no }
      const [value, after] = parseMap(virtual, i, column)
      items.push(value)
      i = after
    } else {
      items.push(scalar(rest, line.no))
      i += 1
    }
  }
  return [items, i]
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {}
  while (i < lines.length && lines[i]!.indent === indent && !isDash(lines[i]!.text)) {
    const line = lines[i]!
    const pair = splitKey(line.text)
    if (!pair) throw new Error(`第 ${line.no} 行：不是 key: value`)
    if (Object.hasOwn(map, pair.key)) throw new Error(`第 ${line.no} 行：重复的键 ${pair.key}`)
    i += 1
    if (pair.rest) {
      map[pair.key] = scalar(pair.rest, line.no)
      continue
    }
    const next = lines[i]
    if (next && (next.indent > indent || (next.indent === indent && isDash(next.text)))) {
      const [value, after] = parseNode(lines, i, next.indent)
      map[pair.key] = value
      i = after
    } else {
      map[pair.key] = null
    }
  }
  if (i < lines.length && lines[i]!.indent > indent) throw new Error(`第 ${lines[i]!.no} 行：缩进对不上`)
  return [map, i]
}

/** `key: rest`（键可以带引号；冒号后面要么是空白要么是行尾） */
function splitKey(text: string): { key: string; rest: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+|$)/.exec(text)
  if (quoted) return { key: scalar(quoted[1]!, 0) as string, rest: text.slice(quoted[0].length).trim() }
  const plain = /^([^\s'"[\]{},#&*!|>%@`-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+|$)/.exec(text)
  if (!plain) return null
  return { key: plain[1]!, rest: text.slice(plain[0].length).trim() }
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let quote: string | null = null
  let current = ''
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '[' || ch === '{') {
      throw new Error('不认嵌套的流式结构')
    } else if (ch === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function scalar(text: string, no: number): unknown {
  const value = text.trim()
  if (value.startsWith('"')) return JSON.parse(value) as string
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`第 ${no} 行：单引号没闭合`)
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`第 ${no} 行：[ 没闭合`)
    return splitFlow(value.slice(1, -1)).map((part) => scalar(part, no))
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new Error(`第 ${no} 行：{ 没闭合`)
    const map: Record<string, unknown> = {}
    for (const part of splitFlow(value.slice(1, -1))) {
      const pair = splitKey(part)
      if (!pair) throw new Error(`第 ${no} 行：{ } 里不是 key: value`)
      map[pair.key] = scalar(pair.rest, no)
    }
    return map
  }
  if (/^[|>][-+]?$/.test(value) || /^[&*!]/.test(value)) throw new Error(`第 ${no} 行：不认块标量 / 锚点 / 标签`)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}
