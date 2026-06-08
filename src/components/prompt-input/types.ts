/**
 * Slate-style node model for the Vue prompt-input editor.
 *
 * Public types mirror Slate's vocabulary so a developer who knows the
 * Slate example can read this code without translating concepts:
 *   - Descendant  = a top-level node in the document
 *   - Element     = a node with children (paragraph, custom inline, etc.)
 *   - Text        = a leaf with a `text` string
 *   - Path        = an array of indices locating a node in the tree
 *   - Point       = { path, offset } — a position inside a Text leaf
 *   - Range       = { anchor, focus } — a selection
 *
 * `Editor` is the mutator object the consumer uses; it carries reactive
 * `children` and `selection` so Vue re-renders on every change.
 *
 * Plugin model:
 *   - `CustomInline` is a generic inline-void node identified by `type`.
 *   - Plugins (see `PromptPlugin`) register an `inline.type` and an optional
 *     trigger keyword; the component renders matched nodes through the
 *     `#element:<plugin.name>` slot, and the trigger popover through the
 *     `#portal:<plugin.name>` slot.
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

export type EmptyText = {
  text: string
}

/**
 * Generic inline-void node.  Each plugin registers a unique `type`; the
 * component renders the node through the `#element:<plugin.name>` slot.
 */
export type CustomInline = {
  type: string
  /** Plugin-specific payload.  Opaque to the editor core. */
  data?: unknown
  children: [EmptyText]
  /** Reserved for legacy mention nodes. */
  character?: string
}

export type Paragraph = {
  type: 'paragraph'
  children: Array<CustomText | CustomInline>
}

export type Element = Paragraph | CustomInline

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

// --- plugin --------------------------------------------------------------

/**
 * Trigger configuration for a plugin.  When the caret sits at a position
 * matching the pattern (default `^{escape(key)}(\\S*)$`) the editor emits a
 * trigger context and the corresponding `#portal:<name>` slot is rendered.
 */
export type PluginTrigger = {
  /** The literal trigger character, e.g. '@', '/', '#'.  Required. */
  key: string
  /** Custom regexp; first capture group becomes `search`. */
  pattern?: RegExp
}

export type PluginInlineSpec = {
  /** Element `type` identifier; defaults to plugin name. */
  type?: string
  /** Defaults to true. */
  isVoid?: boolean
  /** Defaults to true. */
  isInline?: boolean
}

export type TriggerContext = {
  /** Plugin name that produced this trigger. */
  name: string
  /** Captured search term after the trigger key. */
  search: string
  /** Range covering the trigger text in the document. */
  range: Range
}

/**
 * One slice produced by a plugin's {@link PromptPlugin.parse}.
 *
 *   - `text` : a chunk of plain text the plugin did **not** consume.  It
 *     will be re-fed to other plugins (in registration order, latest first)
 *     until no plugin claims it.
 *   - `node` : a chunk the plugin recognised; the editor turns it into an
 *     inline-void {@link CustomInline} of `type` carrying `data`.
 *
 * Authors typically build these via the `splitByRegex` helper exported
 * from `prompt-input`.
 */
export type ParsedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'node'; type: string; data?: unknown }

export interface PromptPlugin {
  /** Unique name; routes slots `element:<name>` and `portal:<name>`. */
  name: string
  /**
   * Optional input-trigger spec.  When absent the plugin **does not** open
   * a popover on typing — it can still participate in text↔model parsing
   * via {@link parse}/{@link serialize}.
   */
  trigger?: PluginTrigger
  inline?: PluginInlineSpec
  /**
   * Replace `payload.range` with an inline node carrying `payload.data`.
   * Default behaviour is provided when omitted (only meaningful for
   * plugins that declare a {@link trigger}).
   */
  commit?: (
    editor: Editor,
    payload: { range: Range; data: unknown }
  ) => void
  /** Intercept keydown while this plugin's popover is active. */
  onKeyDown?: (event: KeyboardEvent, ctx: TriggerContext) => boolean
  /**
   * Split a chunk of plain text into a sequence of segments.  Anything the
   * plugin does not recognise should be returned as `{ kind: 'text', text }`
   * so that other plugins (and the editor) can keep processing it.
   *
   * **Override semantics:** the editor runs `parse` in *reverse* registration
   * order, so a plugin registered later sees the text first and may "claim"
   * substrings before earlier plugins do.
   */
  parse?: (text: string) => ParsedSegment[]
  /**
   * Render a {@link CustomInline} produced by this plugin back to its
   * source text representation.  Required if {@link parse} can emit nodes
   * of this plugin's type and the editor's value should round-trip.
   */
  serialize?: (node: CustomInline) => string
}

// --- editor --------------------------------------------------------------

export type Editor = {
  children: Descendant[]
  selection: Range | null
  /**
   * Monotonically increasing counter incremented on every model
   * mutation.  Components can watch this to force a re-render when
   * deep reactivity doesn't propagate (e.g. nested array replacement
   * inside a ref-backed editor).
   */
  revision: number
  isInline: (node: Element) => boolean
  isVoid: (node: Element) => boolean
  insertText: (text: string) => void
  deleteBackward: (unit?: 'character' | 'word' | 'line' | 'block') => void
  deleteForward: (unit?: 'character' | 'word' | 'line' | 'block') => void
  /** Apply a transform and notify subscribers. */
  apply: () => void
  /**
   * Roll back the last content-changing commit (selection-only commits
   * are intentionally **not** undo'able on their own; they ride along
   * with the next content commit).  No-op when the history stack is
   * empty.
   */
  undo: () => void
  /** Re-apply the most recently undone commit. */
  redo: () => void
  /** Plugin registry keyed by plugin.name (read-only outside core). */
  __plugins?: Map<string, PromptPlugin>
}

// --- demo helper ---------------------------------------------------------

/** Demo data shape from `characters.ts`. */
export type MentionItem = {
  id: string
  character: string
}

// Re-export Ref so consumer-side types files can import from one place.
export type { Ref }