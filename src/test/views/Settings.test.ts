import { afterEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import Settings from "@/views/Settings.vue"
import { fetchSession } from "@/lib/auth"
import { displayPreferences, resetDisplayPreferences } from "@/lib/preferences"

/**
 * 设置页。用户信息是只读的一块，日期偏好那一块的关键在于「改完立刻反映到预览上」——
 * 预览走的就是全站同一个 `@/lib/format`，所以预览对了，列表页里的时间也对了。
 */

const USER = {
  id: "u_1",
  subject: "sub-1",
  username: "alice",
  email: "alice@example.com",
  name: "爱丽丝",
  avatarUrl: null,
  roles: ["admin", "canvas:editor"]
}

/** 让 useAuth 里那份模块级状态变成「已登录」 */
async function signIn() {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          enabled: true,
          authenticated: true,
          user: USER,
          expiresAt: null
        }),
        { headers: { "content-type": "application/json" } }
      )
    )
  )
  await fetchSession(true)
}

afterEach(() => {
  resetDisplayPreferences()
})

describe("设置页", () => {
  it("展示当前用户的名字和邮箱，用户 ID 跟在头像那一行", async () => {
    await signIn()
    const wrapper = mount(Settings)
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain("爱丽丝")
    expect(text).toContain("alice@example.com")
    expect(wrapper.get('[data-testid="user-id"]').text()).toContain("u_1")
  })

  it("不展示 OIDC subject 和角色", async () => {
    await signIn()
    const wrapper = mount(Settings)
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain("sub-1")
    expect(text).not.toContain("canvas:editor")
  })

  it("改时区，预览里的时刻跟着换算", async () => {
    await signIn()
    displayPreferences.value.timeZone = "UTC"
    displayPreferences.value.locale = "zh-CN"
    const wrapper = mount(Settings)
    await flushPromises()

    const utc = wrapper.get('[data-testid="preview-time"]').text()

    displayPreferences.value.timeZone = "Asia/Tokyo"
    await flushPromises()
    const tokyo = wrapper.get('[data-testid="preview-time"]').text()

    // 东京比 UTC 早 9 小时，同一时刻显示出来必然不同
    expect(tokyo).not.toBe(utc)
  })

  it("改日期档位，预览里的日期跟着变长", async () => {
    await signIn()
    displayPreferences.value.timeZone = "UTC"
    displayPreferences.value.locale = "zh-CN"
    const wrapper = mount(Settings)
    await flushPromises()

    expect(wrapper.get('[data-testid="preview-date"]').text()).not.toContain("星期")

    displayPreferences.value.dateStyle = "full"
    await flushPromises()
    expect(wrapper.get('[data-testid="preview-date"]').text()).toContain("星期")
  })

  it("预览上方写明按哪个时区、哪个语言渲染", async () => {
    await signIn()
    displayPreferences.value.timeZone = "Asia/Shanghai"
    displayPreferences.value.locale = "zh-CN"
    const wrapper = mount(Settings)
    await flushPromises()

    // 时间对不上时，得先能分清是「没生效」还是「本来就差这几小时」
    const basis = wrapper.get('[data-testid="preview-basis"]').text()
    expect(basis).toContain("Asia/Shanghai")
    expect(basis).toContain("GMT+8")
    expect(basis).toContain("zh-CN")

    displayPreferences.value.timeZone = "UTC"
    await flushPromises()
    expect(wrapper.get('[data-testid="preview-basis"]').text()).toContain("UTC")
  })

  it("跟随浏览器时，注脚写的是浏览器自己的时区", async () => {
    await signIn()
    const wrapper = mount(Settings)
    await flushPromises()

    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(wrapper.get('[data-testid="preview-basis"]').text()).toContain(browserZone)
  })

  it("默认状态下「恢复默认」是禁用的，改过之后才能点", async () => {
    await signIn()
    const wrapper = mount(Settings)
    await flushPromises()

    const button = wrapper
      .findAll("button")
      .find((b) => b.text().includes("恢复默认"))!
    expect(button.attributes("disabled")).toBeDefined()

    displayPreferences.value.timeZone = "UTC"
    await flushPromises()
    expect(button.attributes("disabled")).toBeUndefined()

    await button.trigger("click")
    await flushPromises()
    expect(displayPreferences.value.timeZone).toBe("auto")
  })
})
