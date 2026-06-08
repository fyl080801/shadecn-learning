/**
 * inline-code plugin —— 行内可编辑文本块（类 Markdown ` ... `）
 *
 * 该插件构建在 `@/components/prompt-input` 之上：
 *   - 节点仍是 prompt-input 的"行内 void"，核心引擎无需改动；
 *   - 子区可编辑由 `<InlineCodeEditable>` 组件实现，并通过
 *     `data-inline-editable` 标记让 PromptInput 跳过外层默认事件处理；
 *   - 子区文本变化通过 `commitInlineCodeText` 写回 `node.data.text`，
 *     再触发 `editor.apply()` 完成 model→string 的回流。
 *
 * 文本表示：
 *   - 默认匹配 `` `[^`\n]+` ``（禁止跨行、禁止空内容）。
 *   - 序列化时若 data.text 含换行，会被压缩为空格作防御。
 */
import {
  definePlugin,
  splitByRegex,
  type CustomInline,
  type EditorType,
  type ParsedSegment,
  type PromptPlugin
} from "@/components/prompt-input"

export type InlineCodeData = {
  /** 块内当前文本（不允许包含换行）。 */
  text: string
}

export type InlineCodePluginOptions = {
  /** 节点 `inline.type`，默认 `"inline-code"`，同时也是插件名。 */
  name?: string
  /** 自定义解析正则（必须含 g 标志，第 1 个捕获组为内部文本）。 */
  pattern?: RegExp
  /** 序列化时的左右边界字符，默认 `` ` ``。 */
  fence?: string
}

const DEFAULT_PATTERN = /`([^`\n]+)`/g

/**
 * 创建一个 inline-code 插件实例。建议直接使用默认配置：
 *
 *   import { createInlineCodePlugin } from '@/components/inline-code'
 *   const inlineCode = createInlineCodePlugin()
 *   const { editor } = createEditor({ plugins: [inlineCode] })
 */
export const createInlineCodePlugin = (
  options: InlineCodePluginOptions = {}
): PromptPlugin => {
  const name = options.name ?? "inline-code"
  const pattern = options.pattern ?? DEFAULT_PATTERN
  const fence = options.fence ?? "`"

  return definePlugin({
    name,
    inline: { type: name, isVoid: true, isInline: true },
    parse(text): ParsedSegment[] {
      return splitByRegex(text, pattern, (m) => ({
        kind: "node",
        type: name,
        data: { text: m[1] ?? "" } satisfies InlineCodeData
      }))
    },
    serialize(node): string {
      const data = (node.data ?? { text: "" }) as InlineCodeData
      // 防御：序列化时剥除可能不慎引入的换行。
      const safe = (data.text ?? "").replace(/\n/g, " ")
      return `${fence}${safe}${fence}`
    }
  })
}

/**
 * 在子区文本变更时，把新文本写回节点 `data.text` 并触发 editor.apply()。
 *
 *   const onUpdate = (text: string) =>
 *     commitInlineCodeText(editor, element, text)
 *
 * 注意：此路径不进入 undo 栈——避免每次按键产生一个历史节点。
 * 如需历史记录可在 blur 时显式 snapshot。
 */
export const commitInlineCodeText = (
  editor: EditorType,
  element: CustomInline,
  text: string
): void => {
  // 拦截换行（粘贴等场景）——块内不允许换行。
  const safe = text.replace(/\r?\n/g, " ")
  const data = (element.data ?? { text: "" }) as InlineCodeData
  if (data.text === safe) return
  element.data = { ...data, text: safe } satisfies InlineCodeData
  editor.apply()
}