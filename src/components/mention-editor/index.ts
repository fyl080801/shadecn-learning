/**
 * Public surface — mirrors Slate's API so a developer reading the React
 * example can read this code without translating concepts.
 *
 *   createEditor() + withHistory + withReact + withMentions
 *   Editor.{ before, after, string, range, isCollapsed }
 *   Range.{ edges, isCollapsed, create }
 *   Transforms.{ select, insertNodes, insertText, delete, move }
 *   <MentionEditor :editor :initial-value @change @keydown>
 *   <MentionElement>            (default mention renderer)
 */
export { default as MentionEditor } from "./MentionEditor.vue"
export { default as MentionElement } from "./MentionElement.vue"
export {
  createEditor,
  withHistory,
  withReact,
  withMentions,
  Editor,
  Transforms,
  Range,
  createText,
  createMention,
  createParagraph,
  initializeEditor
} from "./operations"
export {
  toDOMRange,
  toDOMPoint,
  toModelPoint,
  readModelRange,
  applyDOMRange,
  findLeafElement,
  findBlockElement
} from "./selection"
export { characterSource, CHARACTERS } from "./characters"
export type {
  Descendant,
  Element,
  CustomText,
  Paragraph,
  Mention,
  EmptyText,
  Editor as EditorType,
  Path,
  Point,
  Range as RangeType,
  MentionItem,
  Trigger
} from "./types"
