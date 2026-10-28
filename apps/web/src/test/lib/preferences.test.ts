import { afterEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import {
  AUTO,
  DEFAULT_DISPLAY_PREFERENCES,
  DISPLAY_PREFERENCES_KEY,
  displayPreferences,
  intlTimeZoneReliable,
  resetDisplayPreferences,
  resolvedDisplayPreferences,
  searchTimeZones,
  timeZoneEntries,
  timeZoneOptions
} from "@/lib/preferences"

afterEach(() => {
  resetDisplayPreferences()
})

describe("显示偏好", () => {
  it("默认全部跟随浏览器", () => {
    expect(displayPreferences.value).toEqual(DEFAULT_DISPLAY_PREFERENCES)
    expect(resolvedDisplayPreferences.value.timeZone).toBe(AUTO)
    expect(resolvedDisplayPreferences.value.locale).toBe(AUTO)
  })

  it("改动会写进 localStorage", async () => {
    displayPreferences.value.timeZone = "Asia/Tokyo"
    await nextTick()
    const stored = JSON.parse(localStorage.getItem(DISPLAY_PREFERENCES_KEY) ?? "{}")
    expect(stored.timeZone).toBe("Asia/Tokyo")
  })

  it("恢复默认把每一项都还原", () => {
    displayPreferences.value = {
      locale: "en-US",
      timeZone: "UTC",
      dateStyle: "full",
      timeStyle: "medium",
      hourCycle: "h12"
    }
    resetDisplayPreferences()
    expect(displayPreferences.value).toEqual(DEFAULT_DISPLAY_PREFERENCES)
  })

  it("存坏的时区退回「跟随浏览器」，不让 Intl 抛出来", () => {
    displayPreferences.value.timeZone = "不是时区"
    expect(resolvedDisplayPreferences.value.timeZone).toBe(AUTO)
  })

  it("存坏的格式档位退回默认值", () => {
    Object.assign(displayPreferences.value, {
      dateStyle: "巨大",
      timeStyle: "",
      hourCycle: "h37"
    })
    const resolved = resolvedDisplayPreferences.value
    expect(resolved.dateStyle).toBe(DEFAULT_DISPLAY_PREFERENCES.dateStyle)
    expect(resolved.timeStyle).toBe(DEFAULT_DISPLAY_PREFERENCES.timeStyle)
    expect(resolved.hourCycle).toBe(AUTO)
  })

  it("时区候选里有常用的几个", () => {
    const zones = timeZoneOptions()
    expect(zones).toContain("Asia/Shanghai")
    expect(zones).toContain("UTC")
  })
})

describe("Intl 时区探针", () => {
  it("原装 Intl → 可信", () => {
    expect(intlTimeZoneReliable()).toBe(true)
  })

  it("被「强制改时区」的扩展劫持后 → 不可信", () => {
    // 这类扩展的通行做法：包一层 Intl.DateTimeFormat，把传进去的 timeZone 换掉
    const Original = Intl.DateTimeFormat
    const Patched = function (locales?: unknown, options?: object) {
      return new Original(locales as string, {
        ...options,
        timeZone: "America/Los_Angeles"
      })
    } as unknown as typeof Intl.DateTimeFormat
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(Patched)

    // 显式传的时区被忽略 → UTC 和东京算出同一个小时
    expect(intlTimeZoneReliable()).toBe(false)
  })
})

describe("时区搜索", () => {
  const ids = (keyword: string, limit?: number) =>
    searchTimeZones(keyword, limit).items.map((z) => z.id)

  it("空关键字给全量（按 limit 截断），total 是命中总数", () => {
    const { items, total } = searchTimeZones("", 10)
    expect(items).toHaveLength(10)
    expect(total).toBe(timeZoneEntries().length)
  })

  it("按 IANA 名搜，大小写无关", () => {
    expect(ids("shanghai")).toContain("Asia/Shanghai")
    expect(ids("SHANGHAI")).toContain("Asia/Shanghai")
  })

  it("下划线当空格：能搜「los angeles」", () => {
    expect(ids("los angeles")).toContain("America/Los_Angeles")
  })

  it("能用中文搜常用时区", () => {
    expect(ids("上海")).toContain("Asia/Shanghai")
    expect(ids("北京")).toContain("Asia/Shanghai")
    expect(ids("东京")).toContain("Asia/Tokyo")
  })

  it("能用 GMT 偏移搜", () => {
    const plus8 = ids("+8", 500)
    expect(plus8).toContain("Asia/Shanghai")
    expect(plus8).not.toContain("Europe/London")
  })

  it("多个关键字要全部命中，顺序不限", () => {
    expect(ids("asia shang")).toContain("Asia/Shanghai")
    expect(ids("shang asia")).toContain("Asia/Shanghai")
    expect(ids("asia 伦敦")).toHaveLength(0)
  })

  it("搜不到就是空列表，不是兜底给一堆", () => {
    const { items, total } = searchTimeZones("这个时区不存在")
    expect(items).toHaveLength(0)
    expect(total).toBe(0)
  })

  it("列表按 GMT 偏移排序，每条都带偏移标签", () => {
    const entries = timeZoneEntries()
    const offsets = entries.map((z) => z.offsetMinutes)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
    expect(entries.every((z) => z.offsetLabel.startsWith("GMT"))).toBe(true)
  })
})
