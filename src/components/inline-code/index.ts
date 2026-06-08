/**
 * Public surface of the `inline-code` component.
 *
 * 该模块提供了基于 `@/components/prompt-input` 的"行内可编辑代码块"插件
 * 与对应的子区可编辑组件。典型用法：
 *
 *   import {
 *     createInlineCodePlugin,
 *     commitInlineCodeText,
 *     InlineCodeEditable
 *   } from '@/components/inline-code'
 *
 *   const inlineCode = createInlineCodePlugin()
 *   const { editor } = createEditor({ plugins: [inlineCode] })
 */
export { default as InlineCodeEditable } from "./InlineCodeEditable.vue"

export {
  createInlineCodePlugin,
  commitInlineCodeText
} from "./inlineCodePlugin"

export type {
  InlineCodeData,
  InlineCodePluginOptions
} from "./inlineCodePlugin"