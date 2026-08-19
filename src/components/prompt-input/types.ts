/**
 * Vue prompt-input 编辑器的 Slate 风格节点模型。
 *
 * 公开类型沿用 Slate 的术语体系，熟悉 Slate 示例的开发者无需概念转换即可阅读：
 *   - Descendant  = 文档中的顶层节点
 *   - Element     = 包含子节点的节点（段落、自定义 inline 等）
 *   - Text        = 携带 `text` 字符串的叶节点
 *   - Path        = 用于定位树中节点的索引数组
 *   - Point       = { path, offset } — Text 叶节点内的位置
 *   - Range       = { anchor, focus } — 选区
 *
 * `Editor` 是消费者使用的变更对象；它持有响应式的 `children` 和 `selection`，
 * 使 Vue 在每次变更后重新渲染。
 *
 * 插件模型：
 *   - `CustomInline` 是通过 `type` 标识的通用 inline-void 节点。
 *   - 插件（见 `PromptPlugin`）注册一个 `inline.type` 和可选的触发关键词；
 *     组件通过 `#element:<plugin.name>` 槽位渲染匹配的节点，
 *     通过 `#portal:<plugin.name>` 槽位渲染触发弹出层。
 */

import type { Ref } from "vue"

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
 * 通用 inline-void 节点。每个插件注册唯一的 `type`；
 * 组件通过 `#element:<plugin.name>` 槽位渲染该节点。
 */
export type CustomInline = {
  type: string
  /** 插件特定的载荷，对编辑器核心透明。 */
  data?: unknown
  children: [EmptyText]
  /** 保留给旧版 mention 节点。 */
  character?: string
}

export type Paragraph = {
  type: "paragraph"
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
 * 插件的触发器配置。当光标位于匹配模式（默认 `^{escape(key)}(\\S*)$`）
 * 的位置时，编辑器发出触发上下文并渲染对应的 `#portal:<name>` 槽位。
 */
export type PluginTrigger = {
  /** 字面触发字符，如 '@'、'/'、'#'。必填。 */
  key: string
  /** 自定义正则；第一个捕获组作为 `search`。 */
  pattern?: RegExp
}

export type PluginInlineSpec = {
  /** 元素 `type` 标识符；默认为插件名。 */
  type?: string
  /** 默认为 true。 */
  isVoid?: boolean
  /** 默认为 true。 */
  isInline?: boolean
}

export type TriggerContext = {
  /** 产生此触发的插件名。 */
  name: string
  /** 触发字符之后捕获的搜索词。 */
  search: string
  /** 文档中覆盖触发文本的范围。 */
  range: Range
}

/**
 * 插件 {@link PromptPlugin.parse} 产生的片段。
 *
 *   - `text`：插件**未消费**的纯文本片段。它会被重新传递给其他插件
 *     （按注册逆序），直到没有插件认领为止。
 *   - `node`：插件识别的片段；编辑器将其转换为携带 `data` 的
 *     `type` 类型 inline-void {@link CustomInline} 节点。
 *
 * 作者通常通过 `prompt-input` 导出的 `splitByRegex` 辅助函数构建。
 */
export type ParsedSegment =
  | { kind: "text"; text: string }
  | { kind: "node"; type: string; data?: unknown }

export interface PromptPlugin {
  /** 唯一名称；路由至 `element:<name>` 和 `portal:<name>` 槽位。 */
  name: string
  /**
   * 可选的输入触发器配置。省略时插件**不会**在输入时打开弹出层——
   * 但仍可通过 {@link parse}/{@link serialize} 参与 text↔model 解析。
   */
  trigger?: PluginTrigger
  inline?: PluginInlineSpec
  /**
   * 用携带 `payload.data` 的 inline 节点替换 `payload.range`。
   * 省略时提供默认行为（仅对声明了 {@link trigger} 的插件有意义）。
   */
  commit?: (editor: Editor, payload: { range: Range; data: unknown }) => void
  /** 在此插件的弹出层激活时拦截 keydown。 */
  onKeyDown?: (event: KeyboardEvent, ctx: TriggerContext) => boolean
  /**
   * 将一段纯文本拆分为片段序列。插件未识别的内容应返回
   * `{ kind: 'text', text }`，以便其他插件（和编辑器）继续处理。
   *
   * **覆盖语义：** 编辑器按注册**逆序**运行 `parse`，后注册的插件
   * 先看到文本，可以先于先注册的插件"认领"子串。
   */
  parse?: (text: string) => ParsedSegment[]
  /**
   * 将此插件产生的 {@link CustomInline} 渲染回其源文本表示。
   * 当 {@link parse} 可能生成此插件类型的节点且编辑器值需要往返时必填。
   */
  serialize?: (node: CustomInline) => string
}

// --- editor --------------------------------------------------------------

export type Editor = {
  children: Descendant[]
  selection: Range | null
  /**
   * 单调递增的计数器，每次模型变更时自增。组件可监听它在深层响应式
   * 无法传播时（例如在 ref 包装的编辑器内替换嵌套数组）强制重新渲染。
   */
  revision: number
  isInline: (node: Element) => boolean
  isVoid: (node: Element) => boolean
  insertText: (text: string) => void
  deleteBackward: (unit?: "character" | "word" | "line" | "block") => void
  deleteForward: (unit?: "character" | "word" | "line" | "block") => void
  /** 应用变换并通知订阅者。 */
  apply: () => void
  /**
   * 回滚最后一次内容变更提交（纯选区提交**不可**单独撤销；
   * 它们会随下一次内容提交一起处理）。历史栈为空时无操作。
   */
  undo: () => void
  /** 重新应用最近一次撤销的提交。 */
  redo: () => void
  /**
   * 运行 `fn`，使其内部所有 `apply()` 合并为一条撤销记录。
   * 可重入：嵌套 batch 合并到最外层。适用于粘贴混合 inline/text/paragraph
   * 片段等复合编辑场景，使单次 Ctrl+Z 可回滚整个操作。
   */
  batch: (fn: () => void) => void
  /**
   * 运行 `fn`，期间 `apply()` 不再向 undo 栈推入新记录（但仍推进
   * `revision` 与 `lastChildrenRef`，使后续非静音 apply 的快照正确）。
   * 用于"自动同步 / 规范化"等不应作为独立撤销步的副作用——
   * 例如删除运镜 badge 后的重编号、外部素材删除后联动移除引用。
   * 可重入：保存并恢复静音前的状态。
   */
  muteHistory: (fn: () => void) => void
  /** 以 plugin.name 为键的插件注册表（核心外部只读）。 */
  __plugins?: Map<string, PromptPlugin>
}

// --- demo helper ---------------------------------------------------------

/** `characters.ts` 中的演示数据类型。 */
export type MentionItem = {
  id: string
  character: string
}

// 重新导出 Ref，使消费者端类型文件可从统一位置导入。
export type { Ref }
