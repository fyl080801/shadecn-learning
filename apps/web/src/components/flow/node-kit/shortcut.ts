/**
 * 动作快捷键的写法与匹配（REQ-NODEKIT §4.5）。纯函数，不引任何东西。
 *
 * 写法：`+` 连接的若干修饰键 + 一个键，大小写不敏感，例如 `Mod+D`、`Mod+Shift+G`、`F2`。
 * 修饰键只认三个：
 * - `Mod`：Meta 或 Ctrl 任一 —— 和 `useFlowShortcuts` 里 Ctrl+Z 的判法一致（`metaKey || ctrlKey`），
 *   一份快捷键在 macOS 和 Windows 上都能用；
 * - `Shift`、`Alt`。
 *
 * 匹配是**精确**的：写了的修饰键必须按着，没写的必须没按 —— `Mod+D` 不会被 `Mod+Shift+D` 触发。
 * 键名比的是 `event.key`（小写后比），所以 `Mod+Shift+G` 在按着 Shift 时拿到的 `"G"` 也能对上。
 */

export interface Shortcut {
  mod: boolean
  shift: boolean
  alt: boolean
  /** 小写的 `event.key` */
  key: string
}

const MODIFIERS = new Set(["mod", "shift", "alt"])

/** 解析失败抛错 —— 注册表在装配期调它（`validate`），写错的快捷键在启动时就暴露，而不是按了没反应 */
export function parseShortcut(text: string): Shortcut {
  const tokens = text
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  const key = tokens.pop()
  if (!key) throw new Error(`快捷键没有键名：${text}`)
  if (MODIFIERS.has(key)) throw new Error(`快捷键最后一项必须是键名，不能是修饰键：${text}`)
  for (const token of tokens) {
    if (!MODIFIERS.has(token)) throw new Error(`快捷键里有认不出的修饰键 ${token}（只认 Mod / Shift / Alt）：${text}`)
  }
  return { mod: tokens.includes("mod"), shift: tokens.includes("shift"), alt: tokens.includes("alt"), key }
}

export function matchesShortcut(shortcut: Shortcut, event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === shortcut.key &&
    (event.metaKey || event.ctrlKey) === shortcut.mod &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt
  )
}
