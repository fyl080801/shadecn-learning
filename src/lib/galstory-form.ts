/**
 * 配置表单与「patch 语义」之间的那一层。
 *
 * ## 为什么表单不能整份回传
 *
 * 引擎那一侧是 **patch**：**省略一个字段 = 不动这一项**。而表单天然产出的是**整个对象** ——
 * 直接回传的后果不是「多写几个字段」这么轻，而是**往用户的 `config.yaml` 里塞进他从没写过的行**：
 * 一条连接没写 `chunk_timeout_s` 时，接口给的是引擎缺省值 `20.0`，表单原样显示、原样回传，
 * 那一行就凭空长了出来 —— 此后引擎缺省值再改，这条连接也跟不上了，因为它现在「写死」了。
 *
 * 故提交前一律 `diffPatch(draft, original)`：**只发真正被人改动过的那几个键**。顺带白捡两样 ——
 * 两个人改不同字段自然合并（不会后写盖先写），以及表单不认识的字段永远不会被碰。
 *
 * ## 空输入是 null 还是「没填」
 *
 * 数字输入框清空时拿到的是空串。对**可为 null 的字段**（`topP` / `contextWindow` /
 * `idleTimeoutS`…）那就是「清空这一项」= 显式 `null`；对**不可为 null 的字段**
 * （`timeoutS` / `temperature`…）清空则是**没填**，该保持原值不动，绝不能发一个 null 过去
 * （引擎会 400，虽然拦住了，但那是一句用户看不懂的校验错误，而他只是把框清空了）。
 * 两者由 `numberOrNull` / `numberOrKeep` 分开表达。
 */

/** 只留下真正改动过的键。`original` 为 null（新建）时，留下所有「填了东西」的键 */
export function diffPatch<T extends object>(draft: T, original: T | null): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(draft) as (keyof T)[]) {
    const next = draft[key]
    // 新建：空串/undefined 视为没填 —— 让引擎用它自己的缺省，别把缺省值写进文件
    if (original === null) {
      if (next !== "" && next !== undefined) out[key] = next
      continue
    }
    if (!same(next, original[key])) out[key] = next
  }
  return out
}

/** `null` 与 `undefined` 在这里是**同一件事**（都表示「这一格没值」），别让它们制造假改动 */
function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i])
  }
  return a === b
}

/** 可为 null 的数字框：清空 = 显式 null（「把这一项清掉」） */
export function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === "" || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 不可为 null 的数字框：清空 = 没填，回退到 `fallback`（原值），**绝不发 null** */
export function numberOrKeep(value: string | number | null | undefined, fallback: number): number {
  if (value === "" || value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * `+name` / `-name` 那种增量列表 ↔ 一行一个的多行文本。
 *
 * 空行一律丢掉（作者在末尾多敲一个回车不该变成一个空名字的条目）。
 */
export function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function listToLines(list: readonly string[]): string {
  return list.join("\n")
}
