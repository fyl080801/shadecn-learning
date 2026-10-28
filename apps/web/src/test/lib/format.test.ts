import { afterEach, describe, expect, it, vi } from "vitest"

import { formatDate, formatDateTime, formatTime, formatWith } from "@/lib/format"
import { displayPreferences, resetDisplayPreferences } from "@/lib/preferences"

/** 后端出口一律是这种 UTC ISO（带 Z） */
const UTC_ISO = "2026-08-15T14:33:18.000Z"

function stubLocales(...languages: string[]) {
  vi.stubGlobal("navigator", { languages, language: languages[0] })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetDisplayPreferences()
})

describe("formatWith()", () => {
  it("跟随浏览器语言：zh-CN 和 en-US 排出来不一样", () => {
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "short",
      timeZone: "UTC"
    }

    stubLocales("zh-CN")
    const zh = formatWith(UTC_ISO, options)

    stubLocales("en-US")
    const en = formatWith(UTC_ISO, options)

    expect(zh).toBe("2026/8/15")
    expect(en).toBe("8/15/26")
  })

  it("navigator.languages 里的第一项优先", () => {
    stubLocales("de-DE", "en-US")
    expect(formatWith(UTC_ISO, { dateStyle: "short", timeZone: "UTC" })).toBe(
      "15.08.26"
    )
  })

  it("UTC 时间按目标时区换算，不是当字符串截断", () => {
    const options: Intl.DateTimeFormatOptions = { timeStyle: "short", hour12: false }
    stubLocales("zh-CN")

    expect(formatWith(UTC_ISO, { ...options, timeZone: "UTC" })).toBe("14:33")
    // 东八区 +8 小时
    expect(formatWith(UTC_ISO, { ...options, timeZone: "Asia/Shanghai" })).toBe(
      "22:33"
    )
  })

  it("接受 Date / 时间戳 / ISO 字符串，结果一致", () => {
    stubLocales("zh-CN")
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "UTC"
    }
    const date = new Date(UTC_ISO)

    const fromIso = formatWith(UTC_ISO, options)
    expect(formatWith(date, options)).toBe(fromIso)
    expect(formatWith(date.getTime(), options)).toBe(fromIso)
  })

  it("空值和解析不出来的值显示 -", () => {
    stubLocales("zh-CN")
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short" }

    expect(formatWith(null, options)).toBe("-")
    expect(formatWith(undefined, options)).toBe("-")
    expect(formatWith("", options)).toBe("-")
    expect(formatWith("不是日期", options)).toBe("-")
    expect(formatWith(Number.NaN, options)).toBe("-")
  })
})

describe("formatDateTime() / formatDate() / formatTime()", () => {
  it("分别是「日期+时分」「只到天」「只到时分」", () => {
    stubLocales("en-US")

    const dateTime = formatDateTime(UTC_ISO)
    const date = formatDate(UTC_ISO)
    const time = formatTime(UTC_ISO)

    expect(dateTime).toContain(date)
    expect(dateTime).toContain(time)
    expect(date).not.toContain(time)
  })

  it("坏值同样显示 -", () => {
    stubLocales("zh-CN")
    expect(formatDateTime("坏值")).toBe("-")
    expect(formatDate(null)).toBe("-")
    expect(formatTime(undefined)).toBe("-")
  })
})

describe("跟着设置页的显示偏好走", () => {
  it("设了时区就按它换算，不再跟浏览器", () => {
    stubLocales("zh-CN")
    displayPreferences.value.timeZone = "UTC"
    expect(formatTime(UTC_ISO)).toBe("14:33")

    displayPreferences.value.timeZone = "Asia/Shanghai"
    expect(formatTime(UTC_ISO)).toBe("22:33")
  })

  it("设了语言就按它排年月日", () => {
    stubLocales("zh-CN")
    displayPreferences.value.timeZone = "UTC"

    displayPreferences.value.locale = "en-US"
    expect(formatDate(UTC_ISO)).toBe("8/15/26")

    displayPreferences.value.locale = "de-DE"
    expect(formatDate(UTC_ISO)).toBe("15.08.26")
  })

  it("日期/时间的档位影响 formatDate 与 formatTime", () => {
    stubLocales("zh-CN")
    displayPreferences.value.timeZone = "UTC"

    displayPreferences.value.dateStyle = "full"
    expect(formatDate(UTC_ISO)).toContain("星期")

    displayPreferences.value.timeStyle = "medium"
    expect(formatTime(UTC_ISO)).toContain("18")
  })

  it("12/24 小时制按设置来", () => {
    stubLocales("zh-CN")
    displayPreferences.value.timeZone = "UTC"

    displayPreferences.value.hourCycle = "h23"
    expect(formatTime(UTC_ISO)).toBe("14:33")

    displayPreferences.value.hourCycle = "h12"
    expect(formatTime(UTC_ISO)).toMatch(/2:33/)
  })

  it("调用方显式传的选项优先于偏好", () => {
    stubLocales("zh-CN")
    displayPreferences.value.timeZone = "Asia/Tokyo"
    displayPreferences.value.locale = "de-DE"

    // 某处一定要按 UTC 显示时，自己传 timeZone —— 偏好不该把它盖掉
    expect(formatWith(UTC_ISO, { timeStyle: "short", timeZone: "UTC" })).toBe("14:33")
  })

  it("语言标签是坏的也不抛异常，退回浏览器语言", () => {
    stubLocales("zh-CN")
    displayPreferences.value.locale = "这不是语言标签"
    expect(() => formatDate(UTC_ISO)).not.toThrow()
    expect(formatDate(UTC_ISO)).not.toBe("-")
  })
})
