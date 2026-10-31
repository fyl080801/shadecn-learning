/**
 * 画布上所有「写一段话发出去」的输入框共用的**回车规则**（docs/13 §3.7「底部输入框」、docs/20 §3.10）：
 * 节点的底部输入框（`PromptComposer`）、agent 对话框和快捷会话（同一个 `FlowAgentComposer`）。
 *
 * - **回车 = 换行**（默认行为，这里不拦，交给编辑器自己分段）；
 * - **Shift+回车 = 发送**；⌘+回车（Windows / Linux 上 Ctrl+回车）同样是发送 —— 不少人的手已经习惯这一个；
 * - **输入法组字时的回车都不算**：中文输入里按回车是「把拼音上屏」，`isComposing` 在 Safari 上不可靠，keyCode 229 兜底；
 * - 提及列表开着时的回车 / Tab 是「选中这一项」，由提及插件的 `onKeyDown` 先接走，到不了这里。
 */
export function isSendKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.altKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  return event.shiftKey || event.metaKey || event.ctrlKey
}

/** 输入框旁的提示文案 */
export const SEND_KEY_HINT = "回车换行 · Shift+回车发送"
