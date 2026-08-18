/**
 * 日期时间展示的唯一出口：默认跟随浏览器，用户在设置页里另说。
 *
 * 没设置过的时候（默认全是 AUTO）：locale 取 `navigator.languages`（跟地址栏里
 * 网页语言、跟系统区域设置一致），时区交给 Intl 的默认值（浏览器所在时区）。
 * 设置页把偏好写进 `@/lib/preferences`（localStorage），这里读它 —— 那是个响应式
 * 的值，所以改完设置，页面上已经渲染出来的时间会自己跟着变，不用刷新。
 *
 * 格式用 dateStyle/timeStyle 这种预设，而不是自己拼 year/month/day —— 年月日的
 * 顺序、分隔符该长什么样，由 locale 自己决定，中文用户看到 2026/08/15，
 * 英文用户看到 8/15/26。
 *
 * 调用方**显式传进来的选项永远优先**（比如某处一定要按 UTC 显示，就自己传
 * `timeZone: "UTC"`），偏好只填调用方没说的那几项。
 */

import { AUTO, resolvedDisplayPreferences, type DisplayPreferences } from "./preferences"

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

/** 设置里指定了语言就用它，否则跟浏览器走 */
function locales(prefs: DisplayPreferences): string[] | undefined {
  return prefs.locale === AUTO ? browserLocales() : [prefs.locale]
}

/** 把偏好填进调用方没指定的那几项；调用方写了什么就是什么 */
function withPreferences(
  options: Intl.DateTimeFormatOptions,
  prefs: DisplayPreferences
): Intl.DateTimeFormatOptions {
  const merged = { ...options }
  if (merged.timeZone === undefined && prefs.timeZone !== AUTO) {
    merged.timeZone = prefs.timeZone
  }
  if (
    merged.hour12 === undefined &&
    merged.hourCycle === undefined &&
    prefs.hourCycle !== AUTO
  ) {
    merged.hour12 = prefs.hourCycle === "h12"
  }
  return merged
}

function formatter(
  options: Intl.DateTimeFormatOptions,
  prefs: DisplayPreferences
): Intl.DateTimeFormat {
  const tags = locales(prefs)
  const key = `${tags?.join(",") ?? ""}|${JSON.stringify(options)}`
  let cached = formatters.get(key)
  if (!cached) {
    try {
      cached = new Intl.DateTimeFormat(tags, options)
    } catch {
      // 偏好里的语言标签不合法（localStorage 是能手改的）—— 退回浏览器默认
      cached = new Intl.DateTimeFormat(browserLocales(), options)
    }
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
  if (!date) return PLACEHOLDER
  const prefs = resolvedDisplayPreferences.value
  return formatter(withPreferences(options, prefs), prefs).format(date)
}

/** 列表里统一的时间展示：日期 + 时刻 */
export function formatDateTime(value: DateInput): string {
  const { dateStyle, timeStyle } = resolvedDisplayPreferences.value
  return formatWith(value, { dateStyle, timeStyle })
}

/** 只到天，比如邀请链接的过期时间 */
export function formatDate(value: DateInput): string {
  return formatWith(value, { dateStyle: resolvedDisplayPreferences.value.dateStyle })
}

/** 只到时刻，比如「保存于 15:04」 */
export function formatTime(value: DateInput): string {
  return formatWith(value, { timeStyle: resolvedDisplayPreferences.value.timeStyle })
}
