/**
 * Editor + Transforms 命名空间，仿照 Slate API 设计。
 *
 * 设计（镜像 slate-react）：
 *
 * 1. **模型为唯一数据源。** `editor.children` 是 v-for 渲染的唯一内容。
 *    所有操作都给 `editor.children` 赋一个全新数组（不可变风格），确保 Vue 响应式触发。
 *
 * 2. **规范化不变式**（每次提交后执行）：
 *    - 每个段落至少有一个子节点（空文本叶）。
 *    - 段落的首尾子节点始终是文本叶。
 *    - 两个 mention（inline void）元素之间始终存在一个文本叶。
 *    - 相邻的文本叶会被合并。
 *
 * 3. **选区仅停留在文本叶上。** mention 是 inline void；
 *    光标位于其周围空文本叶中。
 */
import { reactive } from "vue"
import type {
  Descendant,
  Editor as EditorType,
  Element,
  Path,
  Point,
  Range as RangeType,
  CustomInline,
  CustomText,
  Paragraph,
  PromptPlugin
} from "./types"

// ---------- 类型守卫 -------------------------------------------------

const isCustomText = (n: Descendant | undefined | null): n is CustomText =>
  !!n && !("children" in n)

const isInlineNode = (n: Descendant | undefined | null): n is CustomInline =>
  !!n &&
  "children" in n &&
  (n as { type?: string }).type !== undefined &&
  (n as { type?: string }).type !== "paragraph"

const isParagraph = (n: Descendant | undefined | null): n is Paragraph =>
  !!n && "children" in n && (n as { type?: string }).type === "paragraph"

// ---------- 路径 / 点 / 范围辅助函数 --------------------------------

export const pathsEqual = (a: Path, b: Path): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const pointsEqual = (a: Point, b: Point): boolean =>
  a.offset === b.offset && pathsEqual(a.path, b.path)

export const comparePoints = (a: Point, b: Point): number => {
  const len = Math.max(a.path.length, b.path.length)
  for (let i = 0; i < len; i++) {
    const av = a.path[i] ?? 0
    const bv = b.path[i] ?? 0
    if (av < bv) return -1
    if (av > bv) return 1
  }
  return a.offset - b.offset
}

export const RangeEdges = (range: RangeType): [Point, Point] =>
  comparePoints(range.anchor, range.focus) <= 0
    ? [range.anchor, range.focus]
    : [range.focus, range.anchor]

export const RangeIsCollapsed = (range: RangeType | null): boolean =>
  !!range && pointsEqual(range.anchor, range.focus)

export const RangeCreate = (
  anchor: Point,
  focus?: Point | null
): RangeType => ({
  anchor,
  focus: focus ?? anchor
})

/** 深拷贝选区，避免 undo/redo 栈引用到活跃选区。 */
const cloneRange = (range: RangeType | null): RangeType | null => {
  if (!range) return null
  return {
    anchor: { path: range.anchor.path.slice(), offset: range.anchor.offset },
    focus: { path: range.focus.path.slice(), offset: range.focus.offset }
  }
}

export const Range = {
  edges: RangeEdges,
  isCollapsed: RangeIsCollapsed,
  create: RangeCreate
}

// ---------- 树遍历（只读） -----------------------------------

export const getText = (editor: EditorType, path: Path): CustomText | null => {
  if (path.length < 2) return null
  const blockIdx = path[0] ?? 0
  const inlineIdx = path[1] ?? 0
  const block = editor.children[blockIdx]
  if (!isParagraph(block)) return null
  const inline = block.children[inlineIdx]
  return isCustomText(inline) ? inline : null
}

const getBlock = (editor: EditorType, blockIdx: number): Paragraph | null => {
  const b = editor.children[blockIdx]
  return isParagraph(b) ? b : null
}

// ---------- Editor 命名空间 -------------------------------------------

export const EditorString = (editor: EditorType, range: RangeType): string => {
  if (RangeIsCollapsed(range)) return ""
  const [start, end] = RangeEdges(range)
  if (pathsEqual(start.path, end.path)) {
    const inline = getText(editor, start.path)
    if (!inline) return ""
    return inline.text.slice(start.offset, end.offset)
  }
  return ""
}

export const EditorBefore = (
  editor: EditorType,
  point: Point,
  options: { unit?: "offset" | "character" | "word" | "line" | "block" } = {}
): Point | null => {
  const unit = options.unit ?? "offset"
  if (point.offset > 0) {
    if (unit === "word") {
      const inline = getText(editor, point.path)
      if (inline) {
        let i = point.offset
        while (i > 0 && /\w/.test(inline.text[i - 1] ?? "")) i--
        return { path: point.path.slice(), offset: i }
      }
    }
    return { path: point.path.slice(), offset: point.offset - 1 }
  }
  // 跨文本叶：查找前一个文本叶。
  const prev = previousTextLeaf(editor, point.path)
  if (prev) {
    const inline = getText(editor, prev)
    if (inline) return { path: prev, offset: inline.text.length }
  }
  return null
}

export const EditorAfter = (editor: EditorType, point: Point): Point | null => {
  const inline = getText(editor, point.path)
  if (inline && point.offset < inline.text.length) {
    return { path: point.path.slice(), offset: point.offset + 1 }
  }
  const next = nextTextLeaf(editor, point.path)
  if (next) return { path: next, offset: 0 }
  return null
}

const previousTextLeaf = (editor: EditorType, path: Path): Path | null => {
  if (path.length < 2) return null
  const bi = path[0] ?? 0
  const ii = path[1] ?? 0
  const block = getBlock(editor, bi)
  if (block) {
    for (let j = ii - 1; j >= 0; j--) {
      if (isCustomText(block.children[j])) return [bi, j]
    }
  }
  for (let b = bi - 1; b >= 0; b--) {
    const pb = getBlock(editor, b)
    if (!pb) continue
    for (let j = pb.children.length - 1; j >= 0; j--) {
      if (isCustomText(pb.children[j])) return [b, j]
    }
  }
  return null
}

const nextTextLeaf = (editor: EditorType, path: Path): Path | null => {
  if (path.length < 2) return null
  const bi = path[0] ?? 0
  const ii = path[1] ?? 0
  const block = getBlock(editor, bi)
  if (block) {
    for (let j = ii + 1; j < block.children.length; j++) {
      if (isCustomText(block.children[j])) return [bi, j]
    }
  }
  for (let b = bi + 1; b < editor.children.length; b++) {
    const nb = getBlock(editor, b)
    if (!nb) continue
    for (let j = 0; j < nb.children.length; j++) {
      if (isCustomText(nb.children[j])) return [b, j]
    }
  }
  return null
}

export const EditorRange = (
  _: EditorType,
  anchor: Point,
  focus?: Point | null
): RangeType => RangeCreate(anchor, focus ?? anchor)

export const EditorIsCollapsed = (
  editor: EditorType,
  range?: RangeType | null
): boolean => RangeIsCollapsed(range ?? editor.selection)

export const EditorUnhangRange = (
  _editor: EditorType,
  range: RangeType
): RangeType => range

export const Editor = {
  string: EditorString,
  before: EditorBefore,
  after: EditorAfter,
  range: EditorRange,
  isCollapsed: EditorIsCollapsed,
  unhangRange: EditorUnhangRange
}

// ---------- 规范化（Slate 风格不变式） ---------------------

/**
 * 规范化段落的子节点：
 *  - 确保首尾子节点是文本叶
 *  - 确保相邻 inline-void 元素之间有文本叶
 *  - 合并相邻文本叶
 *  - 确保至少存在一个文本叶
 */
export const normalizeParagraphChildren = (
  children: Array<CustomText | CustomInline>
): Array<CustomText | CustomInline> => {
  const out: Array<CustomText | CustomInline> = []
  for (const c of children) {
    if (isCustomText(c)) {
      const last = out[out.length - 1]
      if (isCustomText(last)) {
        // 合并
        out[out.length - 1] = { ...last, text: last.text + c.text }
      } else {
        out.push({ ...c })
      }
    } else if (isInlineNode(c)) {
      const last = out[out.length - 1]
      // 确保 inline 元素之前有文本叶
      if (!last || isInlineNode(last)) {
        out.push({ text: "" })
      }
      out.push(c)
    }
  }
  // 确保首子节点是文本
  if (out.length === 0 || isInlineNode(out[0]!)) {
    out.unshift({ text: "" })
  }
  // 确保尾子节点是文本
  const last = out[out.length - 1]
  if (!last || isInlineNode(last)) {
    out.push({ text: "" })
  }
  return out
}

export const normalizeChildren = (children: Descendant[]): Descendant[] => {
  const out: Descendant[] = []
  for (const block of children) {
    if (isParagraph(block)) {
      out.push({
        ...block,
        children: normalizeParagraphChildren(block.children)
      })
    } else {
      out.push(block)
    }
  }
  if (out.length === 0) {
    out.push({ type: "paragraph", children: [{ text: "" }] })
  }
  return out
}

/**
 * 规范化后模型中的 inline 索引可能移位（如在 mention 前插入空文本叶）。
 * 将基于规范化前子节点计算的"逻辑"点转换为规范化后的有效点。
 * 通过 block 索引和按文本计数的 offset 来恢复对应的文本叶。
 *
 * 更简单的做法：期望调用方传入目标*文本叶*路径和 offset，
 * 规范化后重新定位等价的文本叶。
 */
const renormalizeAndCommit = (
  editor: EditorType,
  newChildren: Descendant[],
  desired: { blockIdx: number; textLeafIdx: number; offset: number } | null
): void => {
  const normalized = normalizeChildren(newChildren)
  editor.children = normalized

  if (desired) {
    // 遍历段落，按纯文本叶顺序查找指定索引的文本叶。
    const block = normalized[desired.blockIdx]
    if (isParagraph(block)) {
      const textLeaves: number[] = []
      for (let i = 0; i < block.children.length; i++) {
        if (isCustomText(block.children[i])) textLeaves.push(i)
      }
      const safeIdx = Math.max(
        0,
        Math.min(desired.textLeafIdx, textLeaves.length - 1)
      )
      const inlineIdx = textLeaves[safeIdx] ?? 0
      const leaf = block.children[inlineIdx]
      const len = isCustomText(leaf) ? leaf.text.length : 0
      const off = Math.max(0, Math.min(desired.offset, len))
      editor.selection = RangeCreate({
        path: [desired.blockIdx, inlineIdx],
        offset: off
      })
    }
  }
}

const commitChildren = (
  editor: EditorType,
  newChildren: Descendant[]
): void => {
  editor.children = normalizeChildren(newChildren)
}

const commitSelection = (editor: EditorType, sel: RangeType | null): void => {
  editor.selection = sel
}

// ---------- 纯树构建器 ----------------------------------------

const replaceLeafText = (
  children: Descendant[],
  path: Path,
  newText: string
): Descendant[] | null => {
  if (path.length < 2) return null
  const blockIdx = path[0] ?? 0
  const inlineIdx = path[1] ?? 0
  const block = children[blockIdx]
  if (!isParagraph(block)) return null
  const inline = block.children[inlineIdx]
  if (!isCustomText(inline)) return null
  const newBlockChildren = block.children.map((c, i) =>
    i === inlineIdx ? ({ ...c, text: newText } as CustomText) : c
  )
  return children.map((b, i) =>
    i === blockIdx ? ({ ...b, children: newBlockChildren } as Paragraph) : b
  )
}

const replaceBlockChildren = (
  children: Descendant[],
  blockIdx: number,
  newBlockChildren: Array<CustomText | CustomInline>
): Descendant[] => {
  return children.map((b, i) =>
    i === blockIdx ? ({ ...b, children: newBlockChildren } as Paragraph) : b
  )
}

const dropChild = (children: Descendant[], path: Path): Descendant[] => {
  if (path.length < 2) return children
  const blockIdx = path[0] ?? 0
  const inlineIdx = path[1] ?? 0
  const block = children[blockIdx]
  if (!isParagraph(block)) return children
  const newBlockChildren = block.children.filter((_, i) => i !== inlineIdx)
  return replaceBlockChildren(children, blockIdx, newBlockChildren)
}

// 计算 block 中某个 inline 索引对应的"文本叶索引"。
const textLeafIndex = (block: Paragraph, inlineIdx: number): number => {
  let n = 0
  for (let i = 0; i < inlineIdx; i++) {
    if (isCustomText(block.children[i])) n++
  }
  return n
}

// ---------- 插入 / 删除 / 分割 ------------------------------------

/**
 * 进入模型的文本统一清洗（textToModel 与 insertText 共用）：
 *  - `\r\n` / `\r` → `\n`：随后按"换行 = 段落块边界"处理；
 *  - 剥离 U+200B（零宽空格）与 U+FEFF（零宽不换行空格/BOM）：旧版
 *    contenteditable 编辑器会把自身的零宽占位符序列化进存量值，这些
 *    字符不可见却占据一个光标停靠点——行尾残留时，方向键需要多按一次
 *    才能跨到下一行，且中间一步光标 rect 塌缩（视觉上"光标消失"）。
 *    注意 ZWJ/ZWNJ（U+200C/200D）参与 emoji 与复杂文字合字，不可剥离。
 */
export const sanitizeInputText = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/[\u200B\uFEFF]/g, "")

const EditorInsertText = (editor: EditorType, text: string): void => {
  text = sanitizeInputText(text)
  if (!text) return
  // 模型不变式：文本叶内禁止出现字面 `\n`（换行 = 段落块边界，见
  // serialize.ts 的段落映射约定）。含 `\n` 的叶会绕过零宽占位渲染分支，
  // 空行 div 高度塌为 0。而插入文本携带 `\n` 是真实存在的输入路径：
  // Chrome 在部分 Enter / IME 序列下会发出 data 为 "\n" 的 insertText
  // beforeinput，IME 组合结果也可能带换行。在此唯一入口统一拆成
  // "逐行插入 + splitBlock"，batch 折叠为单条撤销记录。
  if (text.includes("\n")) {
    const lines = text.split("\n")
    editor.batch(() => {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) insertSingleLineText(editor, lines[i]!)
        if (i < lines.length - 1) EditorSplitBlock(editor)
      }
    })
    return
  }
  insertSingleLineText(editor, text)
}

const insertSingleLineText = (editor: EditorType, text: string): void => {
  const sel = editor.selection
  if (!sel) return
  if (!RangeIsCollapsed(sel)) {
    deleteRange(editor, sel)
  }
  const at = editor.selection?.anchor
  if (!at || at.path.length < 2) return
  const inline = getText(editor, at.path)
  if (!inline) return
  const newText =
    inline.text.slice(0, at.offset) + text + inline.text.slice(at.offset)
  const newChildren = replaceLeafText(editor.children, at.path, newText)
  if (!newChildren) return
  const block = getBlock(editor, at.path[0] ?? 0)
  if (!block) return
  const blockIdx = at.path[0] ?? 0
  const tlIdx = textLeafIndex(block, at.path[1] ?? 0)
  renormalizeAndCommit(editor, newChildren, {
    blockIdx,
    textLeafIdx: tlIdx,
    offset: at.offset + text.length
  })
  editor.apply()
}

const deleteRange = (editor: EditorType, range: RangeType): void => {
  const [start, end] = RangeEdges(range)
  if (pathsEqual(start.path, end.path)) {
    const inline = getText(editor, start.path)
    if (!inline) return
    const newText =
      inline.text.slice(0, start.offset) + inline.text.slice(end.offset)
    const newChildren = replaceLeafText(editor.children, start.path, newText)
    if (newChildren) {
      const block = getBlock(editor, start.path[0] ?? 0)
      if (!block) return
      const blockIdx = start.path[0] ?? 0
      const tlIdx = textLeafIndex(block, start.path[1] ?? 0)
      renormalizeAndCommit(editor, newChildren, {
        blockIdx,
        textLeafIdx: tlIdx,
        offset: start.offset
      })
      editor.apply()
    }
    return
  }
  // 跨文本叶重建
  const newChildren: Descendant[] = []
  const sBlock = start.path[0] ?? 0
  const eBlock = end.path[0] ?? 0
  const sInline = start.path[1] ?? 0
  const eInline = end.path[1] ?? 0
  for (let bi = 0; bi < editor.children.length; bi++) {
    const block = editor.children[bi]
    if (!isParagraph(block)) {
      if (block && (bi < sBlock || bi > eBlock)) newChildren.push(block)
      continue
    }
    if (bi < sBlock || bi > eBlock) {
      newChildren.push(block)
      continue
    }
    const newInlines: Array<CustomText | CustomInline> = []
    for (let ii = 0; ii < block.children.length; ii++) {
      const inline = block.children[ii]
      if (!inline) continue
      if (bi === sBlock && ii < sInline) {
        newInlines.push(inline)
        continue
      }
      if (bi === eBlock && ii > eInline) {
        newInlines.push(inline)
        continue
      }
      if (bi === sBlock && ii === sInline) {
        if (isCustomText(inline)) {
          newInlines.push({
            ...inline,
            text: inline.text.slice(0, start.offset)
          })
        }
        continue
      }
      if (bi === eBlock && ii === eInline) {
        if (isCustomText(inline)) {
          // 稍后合并到起始叶上；此处单独跟踪
        }
        continue
      }
      // 严格在选区内的节点 — 丢弃
    }
    if (bi === sBlock) {
      // 将结束叶的尾部追加到起始块中
      const endBlock = editor.children[eBlock]
      if (isParagraph(endBlock)) {
        const endLeaf = endBlock.children[eInline]
        if (isCustomText(endLeaf)) {
          const lastNew = newInlines[newInlines.length - 1]
          const tail = endLeaf.text.slice(end.offset)
          if (isCustomText(lastNew)) {
            newInlines[newInlines.length - 1] = {
              ...lastNew,
              text: lastNew.text + tail
            }
          } else {
            newInlines.push({ text: tail })
          }
        }
        // 同时追加结束块中结束叶之后的剩余 inline
        for (let k = eInline + 1; k < endBlock.children.length; k++) {
          newInlines.push(endBlock.children[k]!)
        }
      }
      newChildren.push({ ...block, children: newInlines })
    }
    // 跳过 sBlock 和 eBlock 之间的块（不推入）
    // 跳过 eBlock（已在上方合并）
  }
  // 选区落在起点
  const startBlock = newChildren[sBlock]
  let tlIdx = 0
  if (isParagraph(startBlock)) {
    tlIdx = textLeafIndex(startBlock, sInline)
  }
  renormalizeAndCommit(editor, newChildren, {
    blockIdx: sBlock,
    textLeafIdx: tlIdx,
    offset: start.offset
  })
  editor.apply()
}

const EditorDeleteBackward = (editor: EditorType): void => {
  const sel = editor.selection
  if (!sel) return
  if (!RangeIsCollapsed(sel)) {
    deleteRange(editor, sel)
    return
  }
  const at = sel.anchor
  if (at.path.length < 2) return
  const blockIdx = at.path[0] ?? 0
  const inlineIdx = at.path[1] ?? 0
  const block = getBlock(editor, blockIdx)
  if (!block) return

  // 光标在文本叶的 offset 0 处：
  if (at.offset === 0) {
    // 如果前一个兄弟节点是 inline-void 元素，移除它。
    const prev = block.children[inlineIdx - 1]
    if (isInlineNode(prev)) {
      const newChildren = dropChild(editor.children, [blockIdx, inlineIdx - 1])
      // 移除 mention 后，规范化会合并周围的空文本叶。
      // 光标落在合并后的文本叶上。合并后的文本叶位于前一个
      // 文本叶的位置（若存在则为 inlineIdx - 2）与当前叶合并处。
      const prevTextIdx =
        inlineIdx >= 2 ? textLeafIndex(block, inlineIdx - 2) : 0
      // 恢复光标 offset = 合并处前一个文本叶的长度。
      const prevText = inlineIdx >= 2 ? block.children[inlineIdx - 2] : null
      const prevLen =
        prevText && isCustomText(prevText) ? prevText.text.length : 0
      renormalizeAndCommit(editor, newChildren, {
        blockIdx,
        textLeafIdx: prevTextIdx,
        offset: prevLen
      })
      editor.apply()
      return
    }
    // 如果位于块的最开头（第一个文本叶，offset 0），
    // 且存在前一个块，则与前一个块合并。
    const isFirstTextLeaf = !block.children
      .slice(0, inlineIdx)
      .some((c) => isCustomText(c))
    if (isFirstTextLeaf && blockIdx > 0) {
      mergeWithPrevious(editor)
      return
    }
    // 否则继续：退格删除前一个文本中的字符。
    const prevTextPath = previousTextLeaf(editor, at.path)
    if (prevTextPath) {
      const prevLeaf = getText(editor, prevTextPath)
      if (prevLeaf && prevLeaf.text.length > 0) {
        const newText = prevLeaf.text.slice(0, -1)
        const newChildren = replaceLeafText(
          editor.children,
          prevTextPath,
          newText
        )
        if (newChildren) {
          const pb = getBlock(editor, prevTextPath[0] ?? 0)
          const tl = pb ? textLeafIndex(pb, prevTextPath[1] ?? 0) : 0
          renormalizeAndCommit(editor, newChildren, {
            blockIdx: prevTextPath[0] ?? 0,
            textLeafIdx: tl,
            offset: newText.length
          })
          editor.apply()
        }
        return
      }
    }
    // 无操作
    editor.apply()
    return
  }

  // 光标在文本叶中间：删除一个字符。
  const inline = getText(editor, at.path)
  if (!inline) return
  const newText =
    inline.text.slice(0, at.offset - 1) + inline.text.slice(at.offset)
  const newChildren = replaceLeafText(editor.children, at.path, newText)
  if (!newChildren) return
  const tl = textLeafIndex(block, inlineIdx)
  renormalizeAndCommit(editor, newChildren, {
    blockIdx,
    textLeafIdx: tl,
    offset: at.offset - 1
  })
  editor.apply()
}

const EditorDeleteForward = (editor: EditorType): void => {
  const sel = editor.selection
  if (!sel) return
  if (!RangeIsCollapsed(sel)) {
    deleteRange(editor, sel)
    return
  }
  const at = sel.anchor
  if (at.path.length < 2) return
  const blockIdx = at.path[0] ?? 0
  const inlineIdx = at.path[1] ?? 0
  const block = getBlock(editor, blockIdx)
  if (!block) return
  const inline = block.children[inlineIdx]
  if (!isCustomText(inline)) return

  // 光标在文本叶中间：向前删除一个字符。
  if (at.offset < inline.text.length) {
    const newText =
      inline.text.slice(0, at.offset) + inline.text.slice(at.offset + 1)
    const newChildren = replaceLeafText(editor.children, at.path, newText)
    if (!newChildren) return
    const tl = textLeafIndex(block, inlineIdx)
    renormalizeAndCommit(editor, newChildren, {
      blockIdx,
      textLeafIdx: tl,
      offset: at.offset
    })
    editor.apply()
    return
  }

  // 光标在当前文本叶末尾：
  // 如果下一个兄弟节点是 inline-void 元素，移除它。
  const next = block.children[inlineIdx + 1]
  if (isInlineNode(next)) {
    const newChildren = dropChild(editor.children, [blockIdx, inlineIdx + 1])
    // 规范化会合并当前和后续文本叶；
    // 光标停在当前文本叶末尾（在合并后的叶中变为 start + currentLength）。
    const tl = textLeafIndex(block, inlineIdx)
    renormalizeAndCommit(editor, newChildren, {
      blockIdx,
      textLeafIdx: tl,
      offset: inline.text.length
    })
    editor.apply()
    return
  }

  // 如果位于块的最后一个文本叶，与下一个块合并。
  const isLastTextLeaf = !block.children
    .slice(inlineIdx + 1)
    .some((c) => isCustomText(c))
  if (isLastTextLeaf && blockIdx < editor.children.length - 1) {
    mergeWithNext(editor)
    return
  }

  // 否则：删除下一个文本叶的首字符。
  const nextTextPath = nextTextLeaf(editor, at.path)
  if (nextTextPath) {
    const nextLeaf = getText(editor, nextTextPath)
    if (nextLeaf && nextLeaf.text.length > 0) {
      const newText = nextLeaf.text.slice(1)
      const newChildren = replaceLeafText(
        editor.children,
        nextTextPath,
        newText
      )
      if (newChildren) {
        const tl = textLeafIndex(block, inlineIdx)
        renormalizeAndCommit(editor, newChildren, {
          blockIdx,
          textLeafIdx: tl,
          offset: inline.text.length
        })
        editor.apply()
      }
    }
  }
}

const mergeWithPrevious = (editor: EditorType): void => {
  const sel = editor.selection
  if (!sel) return
  const at = sel.anchor
  if (at.path.length < 2) return
  const blockIdx = at.path[0] ?? 0
  if (blockIdx === 0) {
    editor.apply()
    return
  }
  const curBlock = getBlock(editor, blockIdx)
  const prevBlock = getBlock(editor, blockIdx - 1)
  if (!curBlock || !prevBlock) return

  // 光标落在合并点：prevBlock 最后一个文本叶的末尾
  // （合并后在合并块中对应的文本叶）。
  // 计算 prevBlock 的文本叶数量和合并处的 offset。
  let joinTextIdx = 0
  let joinOffset = 0
  for (let i = 0; i < prevBlock.children.length; i++) {
    if (isCustomText(prevBlock.children[i])) {
      joinTextIdx = textLeafIndex(prevBlock, i)
      joinOffset = (prevBlock.children[i] as CustomText).text.length
    }
  }
  const newPrevChildren: Array<CustomText | CustomInline> = [
    ...prevBlock.children,
    ...curBlock.children
  ]
  const newChildren = editor.children.slice()
  newChildren[blockIdx - 1] = {
    ...prevBlock,
    children: newPrevChildren
  } as Paragraph
  newChildren.splice(blockIdx, 1)
  renormalizeAndCommit(editor, newChildren, {
    blockIdx: blockIdx - 1,
    textLeafIdx: joinTextIdx,
    offset: joinOffset
  })
  editor.apply()
}

const mergeWithNext = (editor: EditorType): void => {
  const sel = editor.selection
  if (!sel) return
  const at = sel.anchor
  if (at.path.length < 2) return
  const blockIdx = at.path[0] ?? 0
  if (blockIdx >= editor.children.length - 1) {
    editor.apply()
    return
  }
  const curBlock = getBlock(editor, blockIdx)
  const nextBlock = getBlock(editor, blockIdx + 1)
  if (!curBlock || !nextBlock) return

  // 光标停在 curBlock 最后一个文本叶末尾（逻辑合并点）。
  let joinTextIdx = 0
  let joinOffset = 0
  for (let i = 0; i < curBlock.children.length; i++) {
    if (isCustomText(curBlock.children[i])) {
      joinTextIdx = textLeafIndex(curBlock, i)
      joinOffset = (curBlock.children[i] as CustomText).text.length
    }
  }

  const newCurChildren: Array<CustomText | CustomInline> = [
    ...curBlock.children,
    ...nextBlock.children
  ]
  const newChildren = editor.children.slice()
  newChildren[blockIdx] = { ...curBlock, children: newCurChildren } as Paragraph
  newChildren.splice(blockIdx + 1, 1)
  renormalizeAndCommit(editor, newChildren, {
    blockIdx,
    textLeafIdx: joinTextIdx,
    offset: joinOffset
  })
  editor.apply()
}

const EditorSplitBlock = (editor: EditorType): void => {
  const sel = editor.selection
  if (!sel) return
  if (!RangeIsCollapsed(sel)) {
    deleteRange(editor, sel)
  }
  const at = editor.selection?.anchor
  if (!at || at.path.length < 2) return
  const blockIdx = at.path[0] ?? 0
  const inlineIdx = at.path[1] ?? 0
  const block = getBlock(editor, blockIdx)
  if (!block) return
  const inline = block.children[inlineIdx]
  if (!isCustomText(inline)) return

  const beforeText = inline.text.slice(0, at.offset)
  const afterText = inline.text.slice(at.offset)

  // 构建分割后的当前块（分割前）和新块（分割后）。
  // inlineIdx 之前的所有 inline 留在当前块；
  // inlineIdx 处的叶被分割；inlineIdx 之后的内容进入新块。
  const newCurChildren: Array<CustomText | CustomInline> = [
    ...block.children.slice(0, inlineIdx),
    { text: beforeText }
  ]
  const newBlockChildren: Array<CustomText | CustomInline> = [
    { text: afterText },
    ...block.children.slice(inlineIdx + 1)
  ]
  const newBlock: Paragraph = { type: "paragraph", children: newBlockChildren }

  const newChildren = editor.children.map((b, i) =>
    i === blockIdx ? ({ ...b, children: newCurChildren } as Paragraph) : b
  )
  newChildren.splice(blockIdx + 1, 0, newBlock)

  // 光标落在新块第一个文本叶的起点。
  renormalizeAndCommit(editor, newChildren, {
    blockIdx: blockIdx + 1,
    textLeafIdx: 0,
    offset: 0
  })
  editor.apply()
}

// ---------- Transforms 命名空间 --------------------------------------

export const Transforms = {
  select(editor: EditorType, range: RangeType | null): void {
    commitSelection(editor, range)
    editor.apply()
  },

  insertNodes(editor: EditorType, nodes: Descendant | Descendant[]): void {
    const list = Array.isArray(nodes) ? nodes : [nodes]
    const sel = editor.selection
    if (!sel) return
    if (!RangeIsCollapsed(sel)) deleteRange(editor, sel)
    const at = editor.selection?.anchor
    if (!at || at.path.length < 2) return
    const blockIdx = at.path[0] ?? 0
    const inlineIdx = at.path[1] ?? 0
    const block = getBlock(editor, blockIdx)
    if (!block) return
    const offset = at.offset
    const leaf = block.children[inlineIdx]

    // 在光标处插入单个 inline-void 节点。
    if (list.length === 1 && isInlineNode(list[0]!)) {
      const inlineNode = list[0] as CustomInline
      if (isCustomText(leaf)) {
        const before: CustomText = { text: leaf.text.slice(0, offset) }
        const after: CustomText = { text: leaf.text.slice(offset) }
        const newBlockChildren: Array<CustomText | CustomInline> = [
          ...block.children.slice(0, inlineIdx),
          before,
          inlineNode,
          after,
          ...block.children.slice(inlineIdx + 1)
        ]
        const newChildren = replaceBlockChildren(
          editor.children,
          blockIdx,
          newBlockChildren
        )
        // 规范化后，光标应位于 inline-void 之后文本叶的起点（便于继续输入）。
        const tlBefore = textLeafIndex(block, inlineIdx)
        renormalizeAndCommit(editor, newChildren, {
          blockIdx,
          textLeafIdx: tlBefore + 1,
          offset: 0
        })
        editor.apply()
        return
      }
    }

    // 在叶中间光标处插入 text/inline 列表。
    if (isCustomText(leaf)) {
      const before: CustomText = { text: leaf.text.slice(0, offset) }
      const after: CustomText = { text: leaf.text.slice(offset) }
      const inserted = list as Array<CustomText | CustomInline>
      const newBlockChildren = [
        ...block.children.slice(0, inlineIdx),
        before,
        ...inserted,
        after,
        ...block.children.slice(inlineIdx + 1)
      ]
      const newChildren = replaceBlockChildren(
        editor.children,
        blockIdx,
        newBlockChildren
      )
      const tlBefore = textLeafIndex(block, inlineIdx)
      // 光标在最后插入节点之后；放在尾随文本叶的起点。
      renormalizeAndCommit(editor, newChildren, {
        blockIdx,
        textLeafIdx:
          tlBefore + 1 + inserted.filter((n) => isCustomText(n)).length,
        offset: 0
      })
      editor.apply()
    }
  },

  move(editor: EditorType, options: { reverse?: boolean } = {}): void {
    const sel = editor.selection
    if (!sel) return
    const at = sel.anchor
    const next = options.reverse
      ? EditorBefore(editor, at)
      : EditorAfter(editor, at)
    if (next) commitSelection(editor, RangeCreate(next, next))
    editor.apply()
  },

  delete(editor: EditorType, options: { reverse?: boolean } = {}): void {
    if (options.reverse ?? true) EditorDeleteBackward(editor)
    else EditorDeleteForward(editor)
  },

  insertText(editor: EditorType, text: string): void {
    EditorInsertText(editor, text)
  },

  splitBlock(editor: EditorType): void {
    EditorSplitBlock(editor)
  }
}

// ---------- 工厂 + with* 插件 ----------------------------------

export const initializeEditor = (
  editor: EditorType,
  initialValue: Descendant[]
): void => {
  commitChildren(editor, initialValue)
  // 将光标放在最后一个块最后一个文本叶的末尾。
  const children = editor.children
  for (let bi = children.length - 1; bi >= 0; bi--) {
    const block = children[bi]
    if (!isParagraph(block)) continue
    for (let ii = block.children.length - 1; ii >= 0; ii--) {
      const leaf = block.children[ii]
      if (isCustomText(leaf)) {
        commitSelection(
          editor,
          RangeCreate({ path: [bi, ii], offset: leaf.text.length })
        )
        editor.apply()
        return
      }
    }
  }
  commitSelection(editor, RangeCreate({ path: [0, 0], offset: 0 }))
  editor.apply()
}

/**
 * {@link createEditor} 返回的结果。解构获取编辑器实例和注册辅助函数。
 *
 *   const { editor, addPlugin, removePlugin, getPlugins } = createEditor()
 *   addPlugin(mentionPlugin)
 */
export type CreateEditorResult = {
  /** 响应式编辑器实例。 */
  editor: EditorType
  /** 注册插件（对 `plugin.name` 幂等）。 */
  addPlugin: (plugin: PromptPlugin) => void
  /** 按名称移除插件。 */
  removePlugin: (name: string) => void
  /** 查看当前插件注册表（只读快照）。 */
  getPlugins: () => PromptPlugin[]
}

export type CreateEditorOptions = {
  /** 预注册的插件列表。 */
  plugins?: PromptPlugin[]
}

/**
 * 构建基于注册表的 `isInline`/`isVoid` 断言，使编辑器
 * 动态识别所有插件注册的 inline 元素类型。
 */
const installPluginRecognizers = (editor: EditorType): void => {
  if (!editor.__plugins) editor.__plugins = new Map<string, PromptPlugin>()
  const reg = editor.__plugins
  const matchInlineType = (n: Element): PromptPlugin | undefined => {
    const t = (n as { type?: string }).type
    if (!t) return undefined
    for (const p of reg.values()) {
      const pt = p.inline?.type ?? p.name
      if (pt === t) return p
    }
    return undefined
  }
  editor.isInline = (n: Element) => {
    const p = matchInlineType(n)
    if (!p) return false
    return p.inline?.isInline ?? true
  }
  editor.isVoid = (n: Element) => {
    const p = matchInlineType(n)
    if (!p) return false
    return p.inline?.isVoid ?? true
  }
}

export const createEditor = (
  options: CreateEditorOptions = {}
): CreateEditorResult => {
  /**
   * 历史栈。快照为 `{ children, selection }`；每次 `apply()` 在内容变更
   * 提交后（即 `children` 引用变化）推入 `undoStack`。纯选区提交
   * （如 `Transforms.select`、光标移动）**不**创建新的历史条目——
   * 它们合并到下一次内容提交中，使单次 `Ctrl+Z` 回滚最后一次可见编辑，
   * 而非仅回退光标移动。
   *
   * `historyMuted` 在 *重放* undo/redo 时为 true，
   * 使产生的 `apply()` 不会再次推入栈。
   */
  type Snapshot = { children: Descendant[]; selection: RangeType | null }
  const undoStack: Snapshot[] = []
  const redoStack: Snapshot[] = []
  const HISTORY_LIMIT = 100
  let lastChildrenRef: Descendant[] | null = null
  let historyMuted = false
  /**
   * batch 深度计数器。当 > 0 时，`apply()` 仍会修改 `children` 并自增
   * `revision`，但**不会**推入 `undoStack` —— 整个 batch 在退出时
   * 折叠为单条历史记录。
   *
   * 用于"一次粘贴 = 一次撤销"这类需要把多个 Transforms 合并的场景：
   * 进入 batch 时记录 `children` 的引用作为起点，退出时仅当 children
   * 确实发生过变化才往 undoStack 推一次（起点 ref + 入栈前的 selection）。
   */
  let batchDepth = 0
  let batchStartChildren: Descendant[] | null = null
  let batchStartSelection: RangeType | null = null

  const editor: EditorType = reactive({
    children: [] as Descendant[],
    selection: null as RangeType | null,
    revision: 0,
    // 默认值；下方 `installPluginRecognizers` 运行后覆盖。
    isInline: (_: Element) => false,
    isVoid: (_: Element) => false,
    insertText(text: string) {
      Transforms.insertText(this, text)
    },
    deleteBackward() {
      EditorDeleteBackward(this)
    },
    deleteForward() {
      EditorDeleteForward(this)
    },
    apply() {
      // 内容变更时推进 undo 栈（受 historyMuted / batch 控制）；
      // 纯选区提交仅跟踪选区快照。batch 内部跳过推入——
      // batch 包装器会产生单一条目。
      if (this.children !== lastChildrenRef) {
        // 仅非静音的内容变更推入 undo 栈。
        if (!historyMuted && lastChildrenRef !== null && batchDepth === 0) {
          undoStack.push({
            children: lastChildrenRef,
            selection: lastSelectionSnapshot
          })
          if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
        }
        // 任何内容变更（含静音）都使 redo 分支失效，避免 redo
        // 恢复到不含静音变更的旧态。
        if (batchDepth === 0) {
          // 新编辑使 redo 分支失效。
          redoStack.length = 0
        }
        // 即使静音也要推进 lastChildrenRef，使后续非静音 apply
        // 的 undo 快照以"静音变更后"的状态为 before，避免回退到
        // 静音前的旧态。
        lastChildrenRef = this.children
        lastSelectionSnapshot = cloneRange(this.selection)
      } else if (!historyMuted) {
        // 纯选区提交：继续跟踪最新选区，使其落入下一次快照。
        lastSelectionSnapshot = cloneRange(this.selection)
      }
      this.revision = this.revision + 1
    },
    muteHistory(fn: () => void) {
      const wasMuted = historyMuted
      historyMuted = true
      try {
        fn()
      } finally {
        historyMuted = wasMuted
      }
    },
    /**
     * 运行 `fn`，使其内部所有 `apply()` 调用折叠为单条历史记录。
     * 可重入：嵌套的 batch 合并到最外层。
     *
     * 典型用法：粘贴富文本时把多次 insertText / insertNodes / splitBlock
     * 包裹起来，使 Ctrl+Z 能一次性回滚整段粘贴。
     */
    batch(fn: () => void) {
      if (batchDepth === 0) {
        batchStartChildren = this.children
        batchStartSelection = cloneRange(this.selection)
        // 折叠 batch 前的选区，使其成为退出时发出的单条历史记录
        // 的"before"快照。
        lastSelectionSnapshot = batchStartSelection
      }
      batchDepth++
      try {
        fn()
      } finally {
        batchDepth--
        if (batchDepth === 0) {
          // 仅当 batch 产生了真实的内容变更、且未被进行中的
          // undo/redo 重放所静音时才推入。
          if (
            !historyMuted &&
            batchStartChildren !== null &&
            this.children !== batchStartChildren
          ) {
            undoStack.push({
              children: batchStartChildren,
              selection: batchStartSelection
            })
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
            redoStack.length = 0
          }
          batchStartChildren = null
          batchStartSelection = null
        }
      }
    },
    undo() {
      const prev = undoStack.pop()
      if (!prev) return
      // 回滚前将当前状态存入 redo 栈。
      redoStack.push({
        children: this.children,
        selection: cloneRange(this.selection)
      })
      historyMuted = true
      this.children = prev.children
      this.selection = cloneRange(prev.selection)
      lastChildrenRef = this.children
      lastSelectionSnapshot = cloneRange(this.selection)
      this.revision = this.revision + 1
      historyMuted = false
    },
    redo() {
      const next = redoStack.pop()
      if (!next) return
      undoStack.push({
        children: this.children,
        selection: cloneRange(this.selection)
      })
      historyMuted = true
      this.children = next.children
      this.selection = cloneRange(next.selection)
      lastChildrenRef = this.children
      lastSelectionSnapshot = cloneRange(this.selection)
      this.revision = this.revision + 1
      historyMuted = false
    },
    __plugins: new Map<string, PromptPlugin>()
  }) as unknown as EditorType

  // 跟踪最后一次内容快照时的选区。定义在外部（而非响应式对象内部），
  // 使 `apply/undo/redo` 闭包可以修改它。
  let lastSelectionSnapshot: RangeType | null = null

  installPluginRecognizers(editor)

  const addPlugin = (plugin: PromptPlugin): void => {
    if (!editor.__plugins) editor.__plugins = new Map()
    editor.__plugins.set(plugin.name, plugin)
  }
  const removePlugin = (name: string): void => {
    editor.__plugins?.delete(name)
  }
  const getPlugins = (): PromptPlugin[] =>
    editor.__plugins ? Array.from(editor.__plugins.values()) : []

  if (options.plugins) {
    for (const p of options.plugins) addPlugin(p)
  }

  return { editor, addPlugin, removePlugin, getPlugins }
}

// ---------- 工厂辅助函数 ------------------------------------------

export const createText = (
  text: string,
  marks: Partial<CustomText> = {}
): CustomText => ({
  text,
  ...marks
})

/**
 * 为插件定义的元素类型创建通用 inline-void 节点。
 * `data` 字段携带插件特定的载荷，对编辑器核心透明。
 */
export const createInline = (type: string, data?: unknown): CustomInline => ({
  type,
  data,
  children: [{ text: "" }]
})

export const createParagraph = (
  children: Array<CustomText | CustomInline>
): Paragraph => ({
  type: "paragraph",
  children
})
