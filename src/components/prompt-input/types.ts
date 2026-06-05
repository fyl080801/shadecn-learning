/**
 * Slate-style node model for the Vue mention editor.
 *
 * Public types mirror Slate's vocabulary so a developer who knows the
 * Slate example can read this code without translating concepts:
 *   - Descendant  = a top-level node in the document
 *   - Element     = a node with children (paragraph, mention, etc.)
 *   - Text        = a leaf with a `text` string
 *   - Path        = an array of indices locating a node in the tree
 *   - Point       = { path, offset } — a position inside a Text leaf
 *   - Range       = { anchor, focus } — a selection
 *
 * `Editor` is the mutator object the consumer uses; it carries reactive
 * `children` and `selection` so Vue re-renders on every change.
 */

import type { Ref } from 'vue'

// --- node tree -----------------------------------------------------------

export type BaseText = {
  text: string
}

export type CustomText = BaseText & {
  bold?: boolean
  italic?: boolean
  code?: boolean
  underline?: boolean
}

export type Mention = {
  type: 'mention'
  character: string
  children: [EmptyText]
}

export type EmptyText = {
  text: string
}

export type Paragraph = {
  type: 'paragraph'
  children: Array<CustomText | Mention>
}

export type Element = Paragraph | Mention

export type Descendant = Element | CustomText

// --- selection -----------------------------------------------------------

export type Path = number[]

export type Point = {
  path: Path
  offset: number
}

export interface Range {
  anchor: Point
  focus: Point
}

// --- editor --------------------------------------------------------------

export type HistorySnapshot = {
  children: Descendant[]
  selection: Range | null
}

export type Editor = {
  children: Descendant[]
  selection: Range | null
  onChangeListeners: Set<(value: Descendant[]) => void>
  /**
   * Monotonically increasing counter incremented on every model
   * mutation.  Components can watch this to force a re-render when
   * deep reactivity doesn't propagate (e.g. nested array replacement
   * inside a ref-backed editor).
   */
  revision: number
  isInline: (node: Element) => boolean
  isVoid: (node: Element) => boolean
  markableVoid: (node: Element) => boolean
  insertText: (text: string) => void
  deleteBackward: (unit?: 'character' | 'word' | 'line' | 'block') => void
  deleteForward: (unit?: 'character' | 'word' | 'line' | 'block') => void
  /** Apply a transform and notify subscribers. */
  apply: () => void
  // History (added by `withHistory`)
  undo?: () => void
  redo?: () => void
  /** Updated whenever the undo/redo stacks change. */
  historyRevision?: number
}

// --- mention popup -------------------------------------------------------

export type Trigger = {
  search: string
  range: Range
}

export type MentionItem = {
  id: string
  character: string
}

// Re-export Ref so consumer-side types files can import from one place.
export type { Ref }
