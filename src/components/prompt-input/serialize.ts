/**
 * Text ⇄ Model serialization for the plugin-driven prompt-input editor.
 *
 * The component's public `value` is a plain `string`; this file is the
 * single place where strings turn into Slate-style `Descendant[]` and
 * back.  Plugins are the only knob: each plugin contributes optional
 * `parse(text)` / `serialize(node)` hooks (see `types.ts`).
 *
 * Conventions (paragraph mapping):
 *   - `\n\n` separates **paragraphs** (a new `<paragraph>` block).
 *   - A single `\n` is preserved inside one paragraph as a `\n` text leaf.
 *
 * Override semantics:
 *   - `parse` runs in **reverse** registration order so a plugin
 *     registered later "wins" overlapping matches.
 *   - `serialize` does the same: when several plugins claim the same
 *     `inline.type`, the latest registration is chosen.
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

// ---------- helpers ---------------------------------------------------

/**
 * Split a `text` into segments using a `RegExp` and a builder that turns
 * each match into a `ParsedSegment`.  Non-matching slices come back as
 * `{ kind: 'text', text }`.  Empty text slices are dropped.
 *
 * The regex MUST be declared with the global flag (`/.../g`).  We do not
 * silently rebuild it because a non-global regex is almost always an
 * authoring bug.
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
  // Reset state: callers might reuse the same RegExp instance.
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, m.index) })
    }
    out.push(build(m))
    cursor = m.index + m[0].length
    // Defend against zero-width matches (would loop forever otherwise).
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

const pluginInlineType = (p: PromptPlugin): string =>
  p.inline?.type ?? p.name

// ---------- text → model ---------------------------------------------

const segmentsForLine = (
  line: string,
  plugins: PromptPlugin[]
): ParsedSegment[] => {
  // Initial state: one giant text segment for the whole line.
  let segs: ParsedSegment[] = [{ kind: "text", text: line }]
  // Reverse order = "later registration wins".
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
      // Defensive copy + sanity check.
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
  // Editor invariants want every paragraph to start and end on a text leaf
  // and to contain at least one child.  `initializeEditor` itself runs
  // normalisation, but emitting the right shape up-front avoids edge cases
  // where the caret cannot land anywhere.
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
 * Turn a serialized string back into a `Descendant[]` document.
 *
 * Empty input still produces a single empty paragraph so the editor can
 * place the caret somewhere sensible.
 */
export const textToModel = (
  text: string,
  plugins: PromptPlugin[]
): Descendant[] => {
  const paragraphs = (text ?? "").split(/\n\n/)
  const out: Descendant[] = []
  for (const para of paragraphs) {
    const segs = segmentsForLine(para, plugins)
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

// ---------- model → text ---------------------------------------------

const findSerializerFor = (
  type: string,
  plugins: PromptPlugin[]
): ((node: CustomInline) => string) | null => {
  // Reverse order: the latest registration wins, mirroring `parse`.
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
 * Turn the editor's current document into a string.  Inline nodes are
 * delegated to the matching plugin's `serialize`; nodes without a handler
 * are silently skipped (with a `console.warn`) so the user does not lose
 * the rest of the document.
 */
export const modelToText = (
  children: Descendant[],
  plugins: PromptPlugin[]
): string => {
  const lines: string[] = []
  for (const block of children) {
    if (!isParagraph(block)) {
      // Top-level non-paragraph nodes are not part of the supported model
      // shape; skip them defensively.
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
  return lines.join("\n\n")
}

// ---------- range → text (selection serializer) ----------------------

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
): [
    { path: number[]; offset: number },
    { path: number[]; offset: number }
  ] =>
  comparePoint(range.anchor, range.focus) <= 0
    ? [range.anchor, range.focus]
    : [range.focus, range.anchor]

/**
 * Serialize a selection range into its "real string" form, applying each
 * plugin's `serialize` to inline nodes that lie fully inside the range.
 *
 * Rules:
 *   - Text leaves are sliced by `offset` at the range boundaries.
 *   - Inline nodes are atomic: included only when the range fully covers
 *     them (i.e. starts at-or-before the inline's text leaf preceding it,
 *     and ends at-or-after the leaf following it). For partial coverage
 *     we still include the serialized inline if its index sits strictly
 *     between the start/end leaf indices in the same block.
 *   - Paragraph breaks become "\n\n", mirroring `modelToText`.
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
    const startIi = bi === startBi ? start.path[1] ?? 0 : 0
    const endIi = bi === endBi ? end.path[1] ?? 0 : blockChildren.length - 1
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
        const sliceStart =
          bi === startBi && ii === startIi ? start.offset : 0
        const sliceEnd =
          bi === endBi && ii === endIi ? end.offset : text.length
        line += text.slice(sliceStart, sliceEnd)
      }
    }
    lines.push(line)
  }
  return lines.join("\n\n")
}