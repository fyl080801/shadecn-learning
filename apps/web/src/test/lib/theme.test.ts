import { afterEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import {
  THEME_AUTO,
  THEME_STORAGE_KEY,
  resolvedTheme,
  systemTheme,
  theme
} from "@/lib/theme"

/**
 * 主题偏好。要盯住的就两件事：类名有没有落到 `<html>` 上（页面的配色全靠它），
 * 以及坏值会不会把这个类名弄脏。
 *
 * setup.ts 里的 matchMedia 桩恒为 `matches: false`，所以默认的「系统」是浅色。
 */

const html = document.documentElement

afterEach(async () => {
  theme.value = THEME_AUTO
  await nextTick()
})

describe("主题偏好", () => {
  it("默认跟随系统", () => {
    expect(theme.value).toBe(THEME_AUTO)
    expect(systemTheme.value).toBe("light")
    expect(resolvedTheme.value).toBe("light")
  })

  it("选深色 → <html> 上是 dark，并且存进 localStorage", async () => {
    theme.value = "dark"
    await nextTick()

    expect(html.classList.contains("dark")).toBe(true)
    expect(html.classList.contains("light")).toBe(false)
    expect(resolvedTheme.value).toBe("dark")
    // 裸字符串，不是 JSON —— index.html 里那段防闪白的脚本就是这么读的
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
  })

  it("再切回浅色 → dark 类被摘掉", async () => {
    theme.value = "dark"
    await nextTick()
    theme.value = "light"
    await nextTick()

    expect(html.classList.contains("dark")).toBe(false)
    expect(html.classList.contains("light")).toBe(true)
  })

  it("存了不认的值 → 退回跟随系统，不会把它当类名加上去", async () => {
    theme.value = "香槟色" as never
    await nextTick()

    expect(theme.value).toBe(THEME_AUTO)
    expect(html.classList.contains("香槟色")).toBe(false)
    expect(resolvedTheme.value).toBe("light")
  })

  it("跟随系统时取系统的深浅", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("dark"),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false
        }) as unknown as MediaQueryList
    )
    // 系统偏好是模块初始化时读的，得拿一份新的模块才能换掉它
    vi.resetModules()
    const fresh = await import("@/lib/theme")

    expect(fresh.theme.value).toBe(THEME_AUTO)
    expect(fresh.systemTheme.value).toBe("dark")
    expect(fresh.resolvedTheme.value).toBe("dark")
    expect(html.classList.contains("dark")).toBe(true)
  })
})
