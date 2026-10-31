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

/**
 * 一段时长（毫秒），比如 agent 任务「已运行 2 分 05 秒」。不是日期，不吃时区和日期偏好；
 * 负数（两边时钟差，开始时刻是服务端打的）按 0 算，非有限数显示占位符。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return PLACEHOLDER
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`
  return `${seconds} 秒`
}

/**
 * token 数（agent 用量显示）：千以下原样，往上 `12.3K` / `1.2M`。不是日期，不吃偏好；非有限数 / 负数显示占位符。
 */
export function formatTokens(count: number | null | undefined): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return PLACEHOLDER
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimFixed(count / 1000)}K`
  return `${trimFixed(count / 1_000_000)}M`
}

/** 一位小数，`.0` 去掉 */
function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}

/**
 * 美元金额（agent 一轮的费用）：`null` = 模型没有价格信息，显示「未知」（不是 0）；不到一分按 4 位小数，不然 2 位。
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null) return "未知"
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return PLACEHOLDER
  if (value === 0) return "$0"
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}
