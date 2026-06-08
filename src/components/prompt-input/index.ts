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
 */
export { default as PromptInput } from "./PromptInput.vue"

export {
  createEditor,
  Editor,
  Transforms,
  Range,
  createText,
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
  CustomInline,
  EmptyText,
  Editor as EditorType,
  Path,
  Point,
  Range as RangeType,
  MentionItem,
  PromptPlugin,
  PluginTrigger,
  PluginInlineSpec,
  TriggerContext
} from "./types"

export type {
  CreateEditorResult,
  CreateEditorOptions
} from "./operations"