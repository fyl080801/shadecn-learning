/**
 * Public surface of `prompt-input`.
 *
 * The component's value is a plain string; plugins decide how inline
 * tokens (e.g. `@[name](id)`, `{{Ref 3}}`) round-trip through `parse`
 * and `serialize` hooks.  Trigger-driven popovers remain optional.
 *
 * Recommended API (plugin-based):
 *
 *   const { editor, addPlugin } = createEditor()
 *   addPlugin(definePlugin({
 *     name: 'mention',
 *     trigger: { key: '@' },          // optional — input popover
 *     parse: (text) => …,             // text → segments
 *     serialize: (node) => …          // node → text
 *   }))
 *
 *   <PromptInput v-model="text" :editor>
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

export { splitByRegex, textToModel, modelToText } from "./serialize"

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
  TriggerContext,
  ParsedSegment
} from "./types"

export type {
  CreateEditorResult,
  CreateEditorOptions
} from "./operations"