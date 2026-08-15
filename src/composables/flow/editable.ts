/**
 * 事件目标是不是正在输入的地方。
 *
 * 快捷键（Ctrl+Z、Delete、空格…）在输入框里必须让位给输入本身，
 * 键盘相关的 composable 都从这里取同一份判断。
 */
export function isEditableTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
}
