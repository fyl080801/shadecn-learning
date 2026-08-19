/**
 * 文本 ⇄ 模型序列化，服务于插件驱动的 prompt-input 编辑器。
 *
 * 组件对外暴露的 `value` 是纯字符串；本文件是字符串与 Slate 风格
 * `Descendant[]` 互相转换的唯一入口。插件是唯一的扩展点：每个插件
 * 可提供可选的 `parse(text)` / `serialize(node)` 钩子（见 `types.ts`）。
 *
 * 约定（段落映射）：
 *   - 每个 `\n` 分隔一个**段落块**（产生新的 `<paragraph>`，DOM 上是
 *     独立的 `<div data-block-path>`）；空行即空段落（渲染为零宽叶）。
 *   - 文本叶内**不允许**出现字面 `\n`——contenteditable 下依赖
 *     `white-space: pre-wrap` 渲染叶内 `\n` 折行时，浏览器在折行点的
 *     点击定位/光标换算不可靠（长段落尤甚），且与 Enter 产生的
 *     splitBlock 行为（新 div 块）不一致。
 *
 * 覆盖语义：
 *   - `parse` 按**逆序**注册顺序执行，后注册的插件赢得重叠匹配。
 *   - `serialize` 同理：当多个插件声明相同的 `inline.type` 时，
 *     最后注册的插件被选中。
 */
import type {
  CustomInline,
  CustomText,
  Descendant,
  ParsedSegment,
  Paragraph,
  PromptPlugin,
  Range as RangeType
} from "./types"
import { sanitizeInputText } from "./operations"

// ---------- 辅助函数 ---------------------------------------------------

/**
 * 使用 `RegExp` 将 `text` 拆分为片段，builder 将每个匹配转换为
 * `ParsedSegment`。不匹配的部分返回 `{ kind: 'text', text }`。
 * 空文本片段会被丢弃。
 *
 * 正则**必须**带全局标志（`/.../g`）。不会静默重建非全局正则，
 * 因为缺少全局标志几乎总是编写错误。
 */
export const splitByRegex = (
  text: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => ParsedSegment
): ParsedSegment[] => {
  if (!pattern.global) {
    throw new Error(
      `[prompt-input] splitByRegex requires a global RegExp (got ${pattern})`
    )
  }
  const out: ParsedSegment[] = []
  let cursor = 0
  // 重置状态：调用方可能复用同一个 RegExp 实例。
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, m.index) })
    }
    out.push(build(m))
    cursor = m.index + m[0].length
    // 防御零宽匹配（否则会死循环）。
    if (m[0].length === 0) pattern.lastIndex += 1
  }
  if (cursor < text.length) {
    out.push({ kind: "text", text: text.slice(cursor) })
  }
  return out
}

const isParagraph = (n: Descendant): n is Paragraph =>
  "children" in n && (n as { type?: string }).type === "paragraph"

const isInline = (n: Descendant): n is CustomInline =>
  "children" in n &&
  (n as { type?: string }).type !== undefined &&
  (n as { type?: string }).type !== "paragraph"

const pluginInlineType = (p: PromptPlugin): string => p.inline?.type ?? p.name

// ---------- 文本 → 模型 ---------------------------------------------

const segmentsForLine = (
  line: string,
  plugins: PromptPlugin[]
): ParsedSegment[] => {
  // 初始状态：整行一个文本片段。
  let segs: ParsedSegment[] = [{ kind: "text", text: line }]
  // 逆序 = "后注册者优先"。
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i]
    if (!plugin || !plugin.parse) continue
    const next: ParsedSegment[] = []
    for (const s of segs) {
      if (s.kind !== "text" || s.text === "") {
        next.push(s)
        continue
      }
      const produced = plugin.parse(s.text)
      // 防御性拷贝 + 校验。
      for (const p of produced) {
        if (p.kind === "text") {
          if (p.text !== "") next.push(p)
        } else {
          next.push(p)
        }
      }
    }
    segs = next
  }
  return segs
}

const segmentsToParagraphChildren = (
  segs: ParsedSegment[]
): Array<CustomText | CustomInline> => {
  const out: Array<CustomText | CustomInline> = []
  for (const s of segs) {
    if (s.kind === "text") {
      out.push({ text: s.text })
    } else {
      out.push({
        type: s.type,
        data: s.data,
        children: [{ text: "" }]
      })
    }
  }
  // 编辑器不变式要求每个段落以文本叶开头和结尾，且至少有一个子节点。
  // `initializeEditor` 本身会执行规范化，但提前生成正确形状可避免
  // 光标无法定位的边界情况。
  if (out.length === 0) {
    out.push({ text: "" })
    return out
  }
  if (!("text" in out[0]!)) out.unshift({ text: "" })
  const last = out[out.length - 1]!
  if (!("text" in last)) out.push({ text: "" })
  return out
}

/**
 * 将序列化字符串还原为 `Descendant[]` 文档。
 *
 * 空输入仍会生成一个空段落，使编辑器能在合理位置放置光标。
 */
export const textToModel = (
  text: string,
  plugins: PromptPlugin[]
): Descendant[] => {
  // 每个 `\n` 都产生一个新的段落块（对应 DOM 的独立 <div data-block-path>），
  // 空行即空段落。文本叶内不留任何字面 `\n`——与 Enter 的 splitBlock
  // 行为一致，也保证浏览器在每一行上的点击定位/光标换算走的是块级
  // 元素的可靠路径。
  // 先清洗：\r 统一为 \n；剥离存量数据中残留的零宽占位符（U+200B/U+FEFF，
  // 旧版编辑器序列化泄漏），它们不可见却占据光标停靠点，行尾残留时
  // 方向键跨行需要多按一次且光标短暂消失。
  const lines = sanitizeInputText(text ?? "").split("\n")
  const out: Descendant[] = []
  for (const line of lines) {
    const segs = segmentsForLine(line, plugins)
    out.push({
      type: "paragraph",
      children: segmentsToParagraphChildren(segs)
    })
  }
  if (out.length === 0) {
    out.push({ type: "paragraph", children: [{ text: "" }] })
  }
  return out
}

// ---------- 模型 → 文本 ---------------------------------------------

const findSerializerFor = (
  type: string,
  plugins: PromptPlugin[]
): ((node: CustomInline) => string) | null => {
  // 逆序：最后注册的优先，与 `parse` 一致。
  for (let i = plugins.length - 1; i >= 0; i--) {
    const p = plugins[i]
    if (!p) continue
    if (pluginInlineType(p) === type && typeof p.serialize === "function") {
      return p.serialize
    }
  }
  return null
}

/**
 * 将编辑器当前文档转为字符串。inline 节点委托给匹配插件的 `serialize`；
 * 无处理器的节点被静默跳过（带 `console.warn`），确保用户不会丢失
 * 文档其余部分。
 */
export const modelToText = (
  children: Descendant[],
  plugins: PromptPlugin[]
): string => {
  const lines: string[] = []
  for (const block of children) {
    if (!isParagraph(block)) {
      // 顶层非段落节点不属于支持的模型结构；防御性跳过。
      continue
    }
    let line = ""
    for (const child of block.children) {
      if (isInline(child)) {
        const ser = findSerializerFor(child.type, plugins)
        if (ser) {
          line += ser(child)
        } else {
          console.warn(
            `[prompt-input] no serializer for inline type "${child.type}"; ` +
              `node will be dropped from the string output`
          )
        }
      } else {
        line += (child as CustomText).text
      }
    }
    lines.push(line)
  }
  // 一个段落块 = 一行，与 textToModel 的 split('\n') 严格互逆。
  return lines.join("\n")
}

// ---------- 选区 → 文本（选区序列化器） ----------------------

const comparePath = (a: number[], b: number[]): number => {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av < bv) return -1
    if (av > bv) return 1
  }
  return 0
}

const comparePoint = (
  a: { path: number[]; offset: number },
  b: { path: number[]; offset: number }
): number => {
  const p = comparePath(a.path, b.path)
  if (p !== 0) return p
  return a.offset - b.offset
}

const rangeEdges = (
  range: RangeType
): [{ path: number[]; offset: number }, { path: number[]; offset: number }] =>
  comparePoint(range.anchor, range.focus) <= 0
    ? [range.anchor, range.focus]
    : [range.focus, range.anchor]

/**
 * 将选区序列化为真实字符串形式，对完全落在选区内的 inline 节点
 * 应用对应插件的 `serialize`。
 *
 * 规则：
 *   - 文本叶在选区边界处按 `offset` 切片。
 *   - inline 节点是原子的：仅当选区完整覆盖时才包含（即选区起点
 *     在 inline 前面的文本叶之前或等于，终点在后面的文本叶之后或
 *     等于）。对于部分覆盖的情况，如果 inline 的索引严格位于同一
 *     段落的起止叶索引之间，仍会包含其序列化结果。
 *   - 段落（行）分隔符为 "\n"，与 `modelToText` 保持一致。
 */
export const serializeRange = (
  children: Descendant[],
  range: RangeType,
  plugins: PromptPlugin[]
): string => {
  const [start, end] = rangeEdges(range)
  if (comparePoint(start, end) === 0) return ""
  const startBi = start.path[0] ?? 0
  const endBi = end.path[0] ?? 0
  const lines: string[] = []
  for (let bi = startBi; bi <= endBi; bi++) {
    const block = children[bi]
    if (!block || !isParagraph(block)) continue
    const blockChildren = block.children
    const startIi = bi === startBi ? (start.path[1] ?? 0) : 0
    const endIi = bi === endBi ? (end.path[1] ?? 0) : blockChildren.length - 1
    let line = ""
    for (let ii = startIi; ii <= endIi; ii++) {
      const child = blockChildren[ii]
      if (!child) continue
      if (isInline(child)) {
        const ser = findSerializerFor(child.type, plugins)
        if (ser) {
          line += ser(child)
        } else {
          console.warn(
            `[prompt-input] no serializer for inline type "${child.type}"; ` +
              `node will be dropped from selection serialization`
          )
        }
      } else {
        const text = (child as CustomText).text
        const sliceStart = bi === startBi && ii === startIi ? start.offset : 0
        const sliceEnd = bi === endBi && ii === endIi ? end.offset : text.length
        line += text.slice(sliceStart, sliceEnd)
      }
    }
    lines.push(line)
  }
  return lines.join("\n")
}
