/**
 * 日期时间展示的唯一出口：一律跟随浏览器。
 *
 * locale 取 `navigator.languages`（跟地址栏里网页语言、跟系统区域设置一致），
 * 时区交给 Intl 的默认值（浏览器所在时区）。格式用 dateStyle/timeStyle 这种
 * 预设，而不是自己拼 year/month/day —— 年月日的顺序、分隔符该长什么样，由
 * locale 自己决定，中文用户看到 2026/08/15，英文用户看到 8/15/26。
 */

type DateInput = string | number | Date | null | undefined

/** 值缺失或解析不出来时统一显示这个 */
const PLACEHOLDER = "-"

/** Intl.DateTimeFormat 构造不便宜，按参数缓存 */
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * 浏览器当前的语言偏好；非浏览器环境（SSR/测试）返回 undefined，
 * 交给 Intl 用运行时默认 locale。
 */
function browserLocales(): string[] | undefined {
  if (typeof navigator === "undefined") return undefined
  const list = navigator.languages
  if (list && list.length > 0) return [...list]
  return navigator.language ? [navigator.language] : undefined
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locales = browserLocales()
  const key = `${locales?.join(",") ?? ""}|${JSON.stringify(options)}`
  let cached = formatters.get(key)
  if (!cached) {
    cached = new Intl.DateTimeFormat(locales, options)
    formatters.set(key, cached)
  }
  return cached
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 任意 Intl 选项的通用出口，需要别的粒度时用它，不要自己 new 一个 formatter */
export function formatWith(
  value: DateInput,
  options: Intl.DateTimeFormatOptions
): string {
  const date = toDate(value)
  return date ? formatter(options).format(date) : PLACEHOLDER
}

/** 列表里统一的时间展示：日期 + 时分 */
export function formatDateTime(value: DateInput): string {
  return formatWith(value, { dateStyle: "short", timeStyle: "short" })
}

/** 只到天，比如邀请链接的过期时间 */
export function formatDate(value: DateInput): string {
  return formatWith(value, { dateStyle: "short" })
}

/** 只到分钟的时刻，比如「保存于 15:04」 */
export function formatTime(value: DateInput): string {
  return formatWith(value, { timeStyle: "short" })
}
