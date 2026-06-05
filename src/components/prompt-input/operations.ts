/**
 * Editor + Transforms namespaces, modelled on Slate's API.
 *
 * Design (mirrors slate-react):
 *
 * 1. **Model is source of truth.**  `editor.children` is the only thing
 *    the v-for renders.  All operations assign a brand-new array to
 *    `editor.children` (immutable style) so Vue's reactivity fires.
 *
 * 2. **Normalization invariants** (called after every commit):
 *    - Every paragraph has at least one child (a text leaf with empty text).
 *    - First and last child of a paragraph are always text leaves.
 *    - Between two mention (inline void) elements there is always a text leaf.
 *    - Adjacent text leaves are merged.
 *
 * 3. **Selection only stops on text leaves.**  Mentions are inline voids;
 *    the caret sits in the surrounding empty text leaves.
 */
import { reactive } from "vue"
import type {
  Descendant,
  Editor as EditorType,
  Element,
  Path,
  Point,
  Range as RangeType,
  Mention,
  CustomInline,
  CustomText,
  Paragraph,
  PromptPlugin
} from "./types"

// ---------- type guards -------------------------------------------------

const isCustomText = (n: Descendant | undefined | null): n is CustomText =>
  !!n && !("children" in n)

const isInlineNode = (
  n: Descendant | undefined | null
): n is CustomInline =>
  !!n &&
  "children" in n &&
  (n as { type?: string }).type !== undefined &&
  (n as { type?: string }).type !== "paragraph"

const isParagraph = (n: Descendant | undefined | null): n is Paragraph =>
  !!n && "children" in n && (n as { type?: string }).type === "paragraph"

// ---------- path / point / range helpers --------------------------------

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

export const Range = {
  edges: RangeEdges,
  isCollapsed: RangeIsCollapsed,
  create: RangeCreate
}

// ---------- tree walking (read-only) -----------------------------------

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

// ---------- Editor namespace -------------------------------------------

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
  // Cross-leaf: find the previous text leaf.
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

// ---------- normalization (Slate-style invariants) ---------------------

/**
 * Normalize the children of a paragraph:
 *  - Ensure first/last child is a text leaf
 *  - Ensure adjacent inline-void elements have a text leaf between them
 *  - Merge adjacent text leaves
 *  - Ensure at least one text leaf exists
 */
const normalizeParagraphChildren = (
  children: Array<CustomText | CustomInline>
): Array<CustomText | CustomInline> => {
  const out: Array<CustomText | CustomInline> = []
  for (const c of children) {
    if (isCustomText(c)) {
      const last = out[out.length - 1]
      if (isCustomText(last)) {
        // merge
        out[out.length - 1] = { ...last, text: last.text + c.text }
      } else {
        out.push({ ...c })
      }
    } else if (isInlineNode(c)) {
      const last = out[out.length - 1]
      // Ensure there's a text leaf before the inline element
      if (!last || isInlineNode(last)) {
        out.push({ text: "" })
      }
      out.push(c)
    }
  }
  // Ensure first child is text
  if (out.length === 0 || isInlineNode(out[0]!)) {
    out.unshift({ text: "" })
  }
  // Ensure last child is text
  const last = out[out.length - 1]
  if (!last || isInlineNode(last)) {
    out.push({ text: "" })
  }
  return out
}

const normalizeChildren = (children: Descendant[]): Descendant[] => {
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
 * After normalization the model can shift inline indices (e.g. inserting
 * an empty text leaf in front of a mention).  Translate a "logical"
 * point computed against pre-normalize children into a valid post-
 * normalize point.  We do this by recovering the same text leaf via
 * its block index and offset-by-text count.
 *
 * Simpler approach: expect callers to pass a target *text leaf* path
 * and offset, and we re-locate the equivalent leaf after normalization.
 */
const renormalizeAndCommit = (
  editor: EditorType,
  newChildren: Descendant[],
  desired: { blockIdx: number; textLeafIdx: number; offset: number } | null
): void => {
  const normalized = normalizeChildren(newChildren)
  editor.children = normalized

  if (desired) {
    // Walk paragraphs and find the requested text leaf by index in
    // text-leaf-only order.
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

// ---------- pure tree builders ----------------------------------------

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
    i === inlineIdx ? ({ ...c,text: newText } as CustomText) : c
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

// Count which "text leaf index" within a block a given inline index is.
const textLeafIndex = (block: Paragraph, inlineIdx: number): number => {
  let n = 0
  for (let i = 0; i < inlineIdx; i++) {
    if (isCustomText(block.children[i])) n++
  }
  return n
}

// ---------- insert / delete / split ------------------------------------

const EditorInsertText = (editor: EditorType, text: string): void => {
  if (!text) return
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
  // Cross-leaf rebuild
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
          newInlines.push({ ...inline, text: inline.text.slice(0, start.offset) })
        }
    continue
      }
      if (bi === eBlock && ii === eInline) {
        if (isCustomText(inline)) {
          // merged onto the start leaf later; track separately
        }
        continue
      }
      // Nodes strictly inside the range — drop
    }
    if (bi === sBlock) {
      // Append the trailing portion of end leaf into the start block
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
        // Also append remaining inlines after end leaf in end block
        for (let k = eInline + 1; k < endBlock.children.length; k++) {
          newInlines.push(endBlock.children[k]!)
        }
      }
      newChildren.push({ ...block, children: newInlines })
    }
    // skip blocks strictly between sBlock and eBlock (do not push)
    // skip eBlock (already merged above)
  }
  // Selection lands at start
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

  // Caret at offset 0 of a text leaf:
  if (at.offset === 0) {
    // If previous sibling is an inline-void element, drop it.
    const prev = block.children[inlineIdx - 1]
    if (isInlineNode(prev)) {
      const newChildren = dropChild(editor.children, [blockIdx, inlineIdx - 1])
      // After dropping the mention, normalization will merge the
      // surrounding empty text leaves.  Land caret at the merged leaf.
      // The merged text leaf will be at the position of the previous
      // text leaf (inlineIdx - 2 if exists) merged with current.
      const prevTextIdx = inlineIdx >= 2 ? textLeafIndex(block, inlineIdx - 2) : 0
      // Recover caret offset = length of the previous text leaf at merge.
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
    // If we are at the very start of the block (first text leaf, offset 0),
    // and there is a previous block, merge with previous.
    const isFirstTextLeaf = !block.children
      .slice(0, inlineIdx)
      .some((c) => isCustomText(c))
    if (isFirstTextLeaf && blockIdx > 0) {
      mergeWithPrevious(editor)
      return
    }
    // Otherwise, fall through: backspace deletes a char from previous text.
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
    // No-op
    editor.apply()
    return
  }

  // Caret in middle of a text leaf: delete one char.
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

  // Caret in the middle of a text leaf: delete one char forward.
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

  // Caret at end of current text leaf:
  // If next sibling is an inline-void element, drop it.
  const next = block.children[inlineIdx + 1]
  if (isInlineNode(next)) {
    const newChildren = dropChild(editor.children, [blockIdx, inlineIdx + 1])
    // Normalization will merge the current and following text leaves;
    // caret stays at end of current text leaf (which becomes start +
    // currentLength inside the merged leaf).
    const tl = textLeafIndex(block, inlineIdx)
    renormalizeAndCommit(editor, newChildren, {
      blockIdx,
      textLeafIdx: tl,
      offset: inline.text.length
    })
    editor.apply()
    return
  }

  // If we are at the last text leaf of the block, merge with next block.
  const isLastTextLeaf = !block.children
    .slice(inlineIdx + 1)
    .some((c) => isCustomText(c))
  if (isLastTextLeaf && blockIdx < editor.children.length - 1) {
    mergeWithNext(editor)
    return
  }

  // Otherwise: delete first char of next text leaf.
  const nextTextPath = nextTextLeaf(editor,at.path)
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

  // Caret will land at the join point: end of last text leaf of prevBlock
  // (or after merging, the corresponding text leaf in the merged block).
  // Compute the prevBlock text-leaf count and the offset at the join.
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

  // Caret stays at end of curBlock's last text leaf (logical join point).
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

  // Build new current block (before the split) and the new block
  // (after the split).  Keep all inlines before inlineIdx in the
  // current block; split the leaf at inlineIdx; everything after
  // inlineIdx goes to the new block.
  const newCurChildren: Array<CustomText | CustomInline> = [
    ...block.children.slice(0, inlineIdx),
    { text:beforeText }
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

  // Caret lands at start of the new block's first text leaf.
  renormalizeAndCommit(editor, newChildren, {
    blockIdx: blockIdx + 1,
    textLeafIdx: 0,
    offset: 0
  })
  editor.apply()
}

const EditorInsertFragmentText = (editor: EditorType, text: string): void => {
  if (!text) return
  const segments = text.split("\n")
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg) EditorInsertText(editor, seg)
    if (i < segments.length - 1) EditorSplitBlock(editor)
  }
}

// ---------- Transforms namespace --------------------------------------

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

    // Insert a single inline-void node at the caret.
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
        // After normalization, caret should be at the start of the
        // text leaf AFTER the inline-void (so user can keep typing).
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

    // Insert text/inline list at caret in the middle of a leaf.
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
      // Caret after the last inserted node; place at start of trailing
      // text leaf.
      renormalizeAndCommit(editor, newChildren, {
        blockIdx,
        textLeafIdx: tlBefore + 1 + inserted.filter((n) => isCustomText(n)).length,
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

  insertFragmentText(editor: EditorType, text: string): void {
    EditorInsertFragmentText(editor, text)
  },

  splitBlock(editor: EditorType): void {
    EditorSplitBlock(editor)
  }
}

// ---------- factory + with* plugins ----------------------------------

export const initializeEditor = (
  editor: EditorType,
  initialValue: Descendant[]
): void => {
  commitChildren(editor, initialValue)
  // Place caret at end of first text leaf in first block.
  const first = editor.children[0]
  if (isParagraph(first)) {
    let lastTextIdx = -1
    for (let i = 0; i < first.children.length; i++) {
      if (isCustomText(first.children[i])) lastTextIdx = i
    }
    if (lastTextIdx >= 0) {
      const leaf = first.children[lastTextIdx] as CustomText
      commitSelection(
        editor,
        RangeCreate({ path: [0, lastTextIdx], offset: leaf.text.length })
      )
      editor.apply()
      return
    }
  }
  commitSelection(editor, RangeCreate({ path: [0, 0], offset: 0 }))
  editor.apply()
}

/**
 * Result returned by {@link createEditor}.  Destructure to obtain the
 * editor instance and the registration helpers.
 *
 *   const { editor, addPlugin, removePlugin, getPlugins } = createEditor()
 *   addPlugin(mentionPlugin)
 */
export type CreateEditorResult = {
  /** The reactive editor instance. */
  editor: EditorType
  /** Register a plugin (idempotent on `plugin.name`). */
  addPlugin: (plugin: PromptPlugin) => void
  /** Remove a plugin by name. */
  removePlugin: (name: string) => void
  /** Inspect the current plugin registry (read-only snapshot). */
  getPlugins: () => PromptPlugin[]
}

export type CreateEditorOptions = {
  /** Plugins to register up-front. */
  plugins?: PromptPlugin[]
}

/**
 * Build a registry-backed `isInline`/`isVoid` predicate sothe editor
 * dynamically recognises any plugin-registered inline element types.
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
  editor.markableVoid = (n: Element) => {
    const p = matchInlineType(n)
    if (!p) return false
    return p.inline?.isVoid ?? true
  }
}

export const createEditor = (
  options: CreateEditorOptions = {}
): CreateEditorResult => {
  const editor: EditorType = reactive({
    children: [] as Descendant[],
    selection: null as RangeType | null,
    revision: 0,
    onChangeListeners: new Set<(value: Descendant[]) => void>(),
    // Defaults; overridden once `installPluginRecognizers` runs below.
    isInline: (_: Element) => false,
    isVoid: (_: Element) => false,
    markableVoid: (_: Element) => false,
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
      this.revision = this.revision + 1
      const value = JSON.parse(JSON.stringify(this.children)) as Descendant[]
      this.onChangeListeners.forEach((cb) => cb(value))
    },
    __plugins: new Map<string, PromptPlugin>(),
    undo: undefined,
    redo: undefined,
    historyRevision: undefined
  }) as unknown as EditorType

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

/**
 * Standalone plugin registration helper, useful when you already have an
 * editor instance (e.g. created by a legacy code path).
 */
export const addPlugin = (
  editor: EditorType,
  plugin: PromptPlugin
): void => {
  if (!editor.__plugins) editor.__plugins = new Map()
  editor.__plugins.set(plugin.name, plugin)
  installPluginRecognizers(editor)
}

export const withHistory = <T extends EditorType>(editor: T): T => editor
export const withReact = <T extends EditorType>(editor: T): T => editor

/**
 * @deprecated Register a `mention` plugin via `createEditor({ plugins })`
 * or `addPlugin(editor, plugin)` instead.  Kept for backwards compatibility
 * — installs predicates that also recognise the legacy `mention` type
 * regardless of plugin registration.
 */
export const withMentions = <T extends EditorType>(editor: T): T => {
  const originalIsInline = editor.isInline
  editor.isInline = (n: Element) =>
    originalIsInline(n) || n.type === "mention"
  const originalIsVoid = editor.isVoid
  editor.isVoid = (n: Element) =>
    originalIsVoid(n) || n.type === "mention"
  const originalMV = editor.markableVoid
  editor.markableVoid = (n: Element) =>
    originalMV(n) || n.type === "mention"
  return editor
}

// ---------- factory helpers ------------------------------------------

export const createText = (
  text: string,
  marks: Partial<CustomText> = {}
): CustomText => ({
  text,
  ...marks
})

export const createMention = (character: string): Mention => ({
  type: "mention",
  character,
  children: [{ text: "" }]
})

/**
 * Create a generic inline-void node for plugin-defined element types.
 * The `data` field carries plugin-specific payload and is opaque to the
 * editor core.
 */
export const createInline = (
  type: string,
  data?: unknown
): CustomInline => ({
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