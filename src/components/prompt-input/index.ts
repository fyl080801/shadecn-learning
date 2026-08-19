/**
 * `prompt-input` 的对外接口。
 *
 * 组件的值是纯字符串；由插件决定内联 token（如 `@[name](id)`、`{{Ref 3}}`）
 * 如何通过 `parse` 和 `serialize` 钩子进行往返转换。基于触发符的弹出层是可选的。
 *
 * 推荐用法（基于插件）：
 *
 *   const { editor, addPlugin } = createEditor()
 *   addPlugin(definePlugin({
 *     name: 'mention',
 *     trigger: { key: '@' },          // 可选 —— 输入弹出层
 *     parse: (text) => …,             // 文本 → 片段
 *     serialize: (node) => …          // 节点 → 文本
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

export { normalizeChildren, normalizeParagraphChildren } from "./operations"

export {
  toDOMRange,
  toDOMPoint,
  toModelPoint,
  readModelRange,
  applyDOMRange,
  findLeafElement,
  findBlockElement
} from "./selection"

export {
  splitByRegex,
  textToModel,
  modelToText,
  serializeRange
} from "./serialize"

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

export type { CreateEditorResult, CreateEditorOptions } from "./operations"
