import { computed } from "vue"
import { useStorage } from "@vueuse/core"

/**
 * 日期时间的展示偏好。
 *
 * 只存在浏览器里（localStorage），不上服务端：它描述的是「这台机器上想怎么看时间」，
 * 跟账号无关，也不该为它开一张表。和侧边栏的收缩偏好（useAppLayout）是一个路数。
 *
 * **默认全是「跟随浏览器」**，也就是没人去设置页动过它之前，行为和加设置页之前
 * 一模一样：locale 取 `navigator.languages`，时区取 Intl 的运行时默认值。
 * 真正的格式化只有 `@/lib/format` 一个出口，这里只负责存偏好本身。
 */

/** 「跟随浏览器」这一档；locale / timeZone / 时制三项都能取它 */
export const AUTO = "auto"

export const DATE_STYLES = ["short", "medium", "long", "full"] as const
export const TIME_STYLES = ["short", "medium"] as const
export const HOUR_CYCLES = [AUTO, "h23", "h12"] as const

export type DateStylePreference = (typeof DATE_STYLES)[number]
export type TimeStylePreference = (typeof TIME_STYLES)[number]
/** h23 = 24 小时制，h12 = 12 小时制（上午/下午） */
export type HourCyclePreference = (typeof HOUR_CYCLES)[number]

export interface DisplayPreferences {
  /** BCP47 语言标签，或 AUTO */
  locale: string
  /** IANA 时区名（Asia/Shanghai），或 AUTO */
  timeZone: string
  dateStyle: DateStylePreference
  timeStyle: TimeStylePreference
  hourCycle: HourCyclePreference
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  locale: AUTO,
  timeZone: AUTO,
  dateStyle: "short",
  timeStyle: "short",
  hourCycle: AUTO
}

export const DISPLAY_PREFERENCES_KEY = "app:display-preferences"

/**
 * 模块级的一份，和 useAppLayout 里的收缩偏好同理：设置页在改、每个列表页在读，
 * 各建一份就对不上了。`mergeDefaults` 让以后新增字段时老数据也能正常读出来。
 */
export const displayPreferences = useStorage<DisplayPreferences>(
  DISPLAY_PREFERENCES_KEY,
  { ...DEFAULT_DISPLAY_PREFERENCES },
  undefined,
  { mergeDefaults: true }
)

export function resetDisplayPreferences() {
  displayPreferences.value = { ...DEFAULT_DISPLAY_PREFERENCES }
}

/** 浏览器自己的时区；设置页用它给「跟随浏览器」标个括号 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return "UTC"
  }
}

/** 浏览器自己的语言；同上，只是给界面看的 */
export function browserLocale(): string {
  if (typeof navigator === "undefined") return "-"
  return navigator.languages?.[0] ?? navigator.language ?? "-"
}

/**
 * 这个时区名 Intl 认不认。**界面上显示的值必须先过这一关** —— 校验不过的会被
 * `resolvedDisplayPreferences` 退回「跟随浏览器」，要是选择器还照着原值显示，
 * 就成了「按钮上写着 Asia/Shanghai，时间却按本机时区走」，且看不出哪里不对。
 */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Intl 的 `timeZone` 参数还管不管用。
 *
 * 「强制修改时区」这类浏览器扩展的通行做法是劫持 `Intl.DateTimeFormat`，把调用方
 * 传进去的 `timeZone` 一律换成它自己设定的那个。一旦被劫持，这里做什么都没用：
 * 选哪个时区都显示同一个时间，时区列表里每一条算出来的偏移还全都一样
 * （比如清一色 GMT-7）—— 看起来就像应用的 bug，其实是页面里的 Intl 已经不是原装的了。
 *
 * 探针：同一个绝对时刻，UTC 和东京必然差 9 小时。两边一样就说明参数被忽略了。
 */
export function intlTimeZoneReliable(): boolean {
  try {
    const probe = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    const hourIn = (timeZone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        hourCycle: "h23"
      }).format(probe)
    return hourIn("UTC") !== hourIn("Asia/Tokyo")
  } catch {
    return false
  }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/**
 * 用之前先过一遍白名单：localStorage 里的东西用户能手改，
 * 一个拼错的 dateStyle 会让 Intl 直接抛 RangeError，把整页面带崩。
 */
export const resolvedDisplayPreferences = computed<DisplayPreferences>(() => {
  const raw = displayPreferences.value
  const timeZone =
    typeof raw?.timeZone === "string" &&
    raw.timeZone !== AUTO &&
    isSupportedTimeZone(raw.timeZone)
      ? raw.timeZone
      : AUTO
  return {
    locale: typeof raw?.locale === "string" && raw.locale ? raw.locale : AUTO,
    timeZone,
    dateStyle: pick(raw?.dateStyle, DATE_STYLES, DEFAULT_DISPLAY_PREFERENCES.dateStyle),
    timeStyle: pick(raw?.timeStyle, TIME_STYLES, DEFAULT_DISPLAY_PREFERENCES.timeStyle),
    hourCycle: pick(raw?.hourCycle, HOUR_CYCLES, DEFAULT_DISPLAY_PREFERENCES.hourCycle)
  }
})

/**
 * 可选时区列表。现代浏览器直接给全量 IANA 名字；拿不到就退回一小撮常用的，
 * 反正手填的值也会被上面的白名单校验兜住。
 */
export function timeZoneOptions(): string[] {
  const supportedValuesOf = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  try {
    const list = supportedValuesOf?.("timeZone")
    // 全量表里只有 Etc/UTC，没有大家常写的 UTC —— 手动补一个放最前面
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list]
  } catch {
    // 落到下面的兜底列表
  }
  return [...COMMON_TIME_ZONES]
}

/** 下拉里不输关键字时先摆出来的那一撮 */
export const COMMON_TIME_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney"
] as const

/**
 * 中文别名。IANA 名字里只有城市的英文拼写，本地化出来的又是「中国标准时间」
 * 这种带不上城市名的说法 —— 两边都搜不到「上海」「北京」，所以这张小表得手写。
 * 只覆盖常用的，冷门时区照样能用英文名或 GMT 偏移搜到。
 */
const TIME_ZONE_ALIASES: Record<string, string> = {
  UTC: "世界标准时间 格林尼治",
  "Asia/Shanghai": "上海 北京 中国 大陆",
  "Asia/Hong_Kong": "香港",
  "Asia/Macau": "澳门",
  "Asia/Taipei": "台北 台湾",
  "Asia/Tokyo": "东京 日本",
  "Asia/Seoul": "首尔 韩国",
  "Asia/Singapore": "新加坡",
  "Asia/Bangkok": "曼谷 泰国",
  "Asia/Kolkata": "印度 加尔各答 新德里",
  "Asia/Dubai": "迪拜 阿联酋",
  "Europe/London": "伦敦 英国",
  "Europe/Paris": "巴黎 法国",
  "Europe/Berlin": "柏林 德国",
  "Europe/Moscow": "莫斯科 俄罗斯",
  "America/New_York": "纽约 美东",
  "America/Chicago": "芝加哥",
  "America/Denver": "丹佛",
  "America/Los_Angeles": "洛杉矶 旧金山 美西",
  "America/Sao_Paulo": "圣保罗 巴西",
  "Australia/Sydney": "悉尼 澳大利亚",
  "Pacific/Auckland": "奥克兰 新西兰"
}

export interface TimeZoneEntry {
  /** IANA 名字，也是存进偏好里的值 */
  id: string
  /** 当前偏移，形如 GMT+8 */
  offsetLabel: string
  /** 排序用的偏移分钟数 */
  offsetMinutes: number
  /** 在常用表里的名次（越小越靠前）；不在表里的是 NOT_COMMON */
  commonRank: number
  /** 拼好的检索文本，已经全部小写 */
  search: string
}

/** 不在常用表里的名次。用一个大整数而不是 Infinity —— Infinity - Infinity 是 NaN，
 * 排序比较器拿到 NaN 行为就没定义了 */
const NOT_COMMON = 9999

function commonRankOf(id: string): number {
  const index = (COMMON_TIME_ZONES as readonly string[]).indexOf(id)
  return index < 0 ? NOT_COMMON : index
}

/** 全量表算一次就够了：几百次 Intl 构造，不该每敲一个字重来一遍 */
let entriesCache: TimeZoneEntry[] | null = null

function offsetOf(timeZone: string, at: Date): { label: string; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset"
    }).formatToParts(at)
    const label = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT"
    // "GMT+8" / "GMT-3:30" / "GMT"
    const matched = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label)
    if (!matched) return { label, minutes: 0 }
    const sign = matched[1] === "-" ? -1 : 1
    const minutes = sign * (Number(matched[2]) * 60 + Number(matched[3] ?? 0))
    return { label, minutes }
  } catch {
    return { label: "GMT", minutes: 0 }
  }
}

/** 本地化的时区全称（中文下是「中国标准时间」这种），拿不到就算了 */
function longNameOf(locale: string, timeZone: string, at: Date): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    )
  } catch {
    return ""
  }
}

/**
 * 全量时区 + 检索用的文本，按偏移排序（同偏移的按名字）。
 * 检索文本里塞了四样东西：IANA 名、把 `_` 和 `/` 换成空格的写法（这样
 * 「los angeles」能搜到 `America/Los_Angeles`）、本地化的时区全称、中文别名，
 * 外加 GMT 偏移 —— 所以「+8」也是一种搜法。
 */
export function timeZoneEntries(): TimeZoneEntry[] {
  if (entriesCache) return entriesCache
  const now = new Date()
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale
  entriesCache = timeZoneOptions()
    .map((id) => {
      const { label, minutes } = offsetOf(id, now)
      const localName = longNameOf(locale, id, now)
      const parts = [
        id,
        id.replace(/[_/]/g, " "),
        localName,
        TIME_ZONE_ALIASES[id] ?? "",
        label,
        label.replace("GMT", "")
      ]
      return {
        id,
        offsetLabel: label,
        offsetMinutes: minutes,
        commonRank: commonRankOf(id),
        search: parts.join(" ").toLowerCase()
      }
    })
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.id.localeCompare(b.id))
  return entriesCache
}

/**
 * 常用时区，按 COMMON_TIME_ZONES 里写的顺序（不是按偏移）—— 那是给人看的顺序，
 * 中文用户一眼要看到的是 UTC 和上海，不是 GMT-12 开头的那一堆。
 */
export function commonTimeZoneEntries(): TimeZoneEntry[] {
  const byId = new Map(timeZoneEntries().map((entry) => [entry.id, entry]))
  return COMMON_TIME_ZONES.flatMap((id) => {
    const entry = byId.get(id)
    return entry ? [entry] : []
  })
}

/**
 * 按关键字找时区。关键字里的空格当成「每一段都要命中」（顺序不限），
 * 所以「asia shang」「上海 +8」都能搜到。
 *
 * `limit` 是防止把几百条一次性塞进 DOM；`total` 一起返回，界面才好说
 * 「还有多少条没显示」—— 截断了却不说，看起来就像没搜到。
 */
export function searchTimeZones(
  keyword: string,
  limit = 100
): { items: TimeZoneEntry[]; total: number } {
  const entries = timeZoneEntries()
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { items: entries.slice(0, limit), total: entries.length }

  const hit = entries.filter((entry) => terms.every((t) => entry.search.includes(t)))
  /**
   * 常用的排前面。搜「+8」有十几个时区都对，按字母序第一个是南极科考站
   * `Antarctica/Casey` —— 技术上没错，但没人想要，看着就像搜错了。
   */
  const ranked = [...hit].sort((a, b) => a.commonRank - b.commonRank)
  return { items: ranked.slice(0, limit), total: ranked.length }
}

/** 语言不做全量列举 —— 常见几种够用，真要别的再加 */
export const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: "zh-CN", label: "简体中文（zh-CN）" },
  { value: "zh-TW", label: "繁体中文（zh-TW）" },
  { value: "en-US", label: "English (en-US)" },
  { value: "en-GB", label: "English (en-GB)" },
  { value: "ja-JP", label: "日本語（ja-JP）" },
  { value: "ko-KR", label: "한국어（ko-KR）" },
  { value: "de-DE", label: "Deutsch (de-DE)" },
  { value: "fr-FR", label: "Français (fr-FR)" }
]

/**
 * 档位只给名字，**不写死示例**。
 *
 * 一个档位长什么样是 locale 说了算：`medium` 在 zh-CN 下是「2026年8月18日」，
 * 在 en-US 下是「Aug 18, 2026」，而 zh-CN 的 medium 和 long 几乎一模一样。
 * 早先这里写死了中文示例，结果是标签和实际显示对不上 —— 看着就像「设置没生效」。
 * 现在示例由设置页拿真正的 `formatWith` 当场算，永远和实际一致。
 */
export const DATE_STYLE_OPTIONS: { value: DateStylePreference; label: string }[] = [
  { value: "short", label: "短" },
  { value: "medium", label: "中" },
  { value: "long", label: "长" },
  { value: "full", label: "完整" }
]

export const TIME_STYLE_OPTIONS: { value: TimeStylePreference; label: string }[] = [
  { value: "short", label: "时:分" },
  { value: "medium", label: "时:分:秒" }
]

export const HOUR_CYCLE_OPTIONS: { value: HourCyclePreference; label: string }[] = [
  { value: AUTO, label: "跟随浏览器" },
  { value: "h23", label: "24 小时制" },
  { value: "h12", label: "12 小时制" }
]

/** 当前生效的 locale（偏好没指定就是浏览器解析出来的那个），显示给用户看 */
export function effectiveLocale(): string {
  const { locale } = resolvedDisplayPreferences.value
  if (locale !== AUTO) return locale
  try {
    return new Intl.DateTimeFormat(browserLocalesOrDefault()).resolvedOptions().locale
  } catch {
    return browserLocale()
  }
}

/** 当前生效的时区（偏好没指定就是浏览器的） */
export function effectiveTimeZone(): string {
  const { timeZone } = resolvedDisplayPreferences.value
  return timeZone === AUTO ? browserTimeZone() : timeZone
}

/** 某个时区此刻的 GMT 偏移，形如 GMT+8 */
export function offsetLabelOf(timeZone: string): string {
  return offsetOf(timeZone, new Date()).label
}

/** 这个 locale 默认用 12 还是 24 小时制 —— 「跟随浏览器」到底跟到了哪一个 */
export function localeHour12(locale?: string): boolean {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeStyle: "short" }).resolvedOptions().hour12 ??
      false
    )
  } catch {
    return false
  }
}

function browserLocalesOrDefault(): string[] | undefined {
  if (typeof navigator === "undefined") return undefined
  const list = navigator.languages
  if (list && list.length > 0) return [...list]
  return navigator.language ? [navigator.language] : undefined
}

export function useDisplayPreferences() {
  return {
    preferences: displayPreferences,
    resolved: resolvedDisplayPreferences,
    reset: resetDisplayPreferences
  }
}
