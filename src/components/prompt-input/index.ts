/**
 * Public surface of `prompt-input`.
 *
 * Recommended API (plugin-based):
 *
 *   const { editor, addPlugin } = createEditor()
 *   addPlugin(definePlugin({ name: 'mention', trigger: { key: '@' } }))
 *
 *   <PromptInput :editor :initial-value>
 *     <template #element:mention="{ element, attributes }">…</template>
 *     <template #portal:mention="{ trigger, commit, close }">…</template>
 *   </PromptInput>
 *
 * Legacy `MentionEditor` / `MentionElement` are still exported for
 * backwards compatibility.
 */
export { default as PromptInput } from "./PromptInput.vue"

// --- legacy re-exports (backwards compatible) ---
export { default as MentionEditor } from "./MentionEditor.vue"
export { default as MentionElement } from "./MentionElement.vue"

export {
  createEditor,
  addPlugin,
  withHistory,
  withReact,
  withMentions,
  Editor,
  Transforms,
  Range,
  createText,
  createMention,
  createInline,
  createParagraph,
  initializeEditor
} from "./operations"

export {
  definePlugin,
  defaultTriggerPattern,
  getTriggerPattern
} from "./definePlugin"

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
  CustomInline,
  EmptyText,
  Editor as EditorType,
  Path,
  Point,
  Range as RangeType,
  MentionItem,
  Trigger,
  PromptPlugin,
  PluginTrigger,
  PluginInlineSpec,
  TriggerContext
} from "./types"

export type {
  CreateEditorResult,
  CreateEditorOptions
} from "./operations"