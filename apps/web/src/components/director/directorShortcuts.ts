/**
 * 导演台全屏层里自己的快捷键（docs/07 §7.6）。按键 → 动作的映射只在这里，路由（谁的焦点、要不要让给输入框）
 * 在 `FlowDirectorOverlay.vue`。
 *
 * - Delete / Backspace：删选中的关键帧，没选关键帧就删选中的对象；
 * - Mod+Z 撤销、Mod+Shift+Z / Mod+Y 重做（Mod = Meta 或 Ctrl）—— 只作用于导演台自己的撤销栈；
 * - 空格：播放 / 暂停。
 */
export type DirectorShortcut = "delete" | "undo" | "redo" | "toggle-play"

export function directorShortcutOf(event: KeyboardEvent): DirectorShortcut | null {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (mod && !event.altKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo"
    if (key === "y" && !event.shiftKey) return "redo"
    return null
  }
  if (event.altKey) return null
  if (key === "delete" || key === "backspace") return "delete"
  if (event.key === " " && !event.shiftKey) return "toggle-play"
  return null
}
