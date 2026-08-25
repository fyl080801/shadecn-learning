import { afterEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter } from "vue-router"

import Settings from "@/views/Settings.vue"
import { fetchSession } from "@/lib/auth"
import { displayPreferences, resetDisplayPreferences } from "@/lib/preferences"
import { THEME_AUTO, theme } from "@/lib/theme"

/**
 * 设置页。用户信息是只读的一块，日期偏好那一块的关键在于「改完立刻反映到预览上」——
 * 预览走的就是全站同一个 `@/lib/format`，所以预览对了，列表页里的时间也对了。
 *
 * 「登录方式」那张卡片有自己的用例（components/LinkedAccounts.test.ts），
 * 这里只把它的接口挡掉，免得每条用例都要陪着它打桩。
 */

vi.mock("@/lib/api", () => ({
  authApi: {
    identities: () => Promise.resolve({ items: [], pending: null }),
    config: () =>
      Promise.resolve({ enabled: true, provider: "keycloak", providers: [] }),
    unlinkIdentity: () => Promise.resolve(),
    startLink: () => {},
    confirmLink: () => Promise.resolve({ identity: null }),
    cancelLink: () => Promise.resolve()
  }
}))

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

/** 设置页里的「登录方式」卡片要用路由（读并洗掉关联结果的 query） */
async function mountSettings() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/settings", component: { template: "<div />" } }]
  })
  await router.push("/settings")
  await router.isReady()

  const wrapper = mount(Settings, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  resetDisplayPreferences()
  theme.value = THEME_AUTO
})

describe("设置页", () => {
  it("展示当前用户的名字和邮箱，用户 ID 跟在头像那一行", async () => {
    await signIn()
    const wrapper = await mountSettings()

    const text = wrapper.text()
    expect(text).toContain("爱丽丝")
    expect(text).toContain("alice@example.com")
    expect(wrapper.get('[data-testid="user-id"]').text()).toContain("u_1")
  })

  it("不展示 OIDC subject 和角色", async () => {
    await signIn()
    const wrapper = await mountSettings()

    const text = wrapper.text()
    expect(text).not.toContain("sub-1")
    expect(text).not.toContain("canvas:editor")
  })

  it("点「深色」立刻切主题，<html> 上就是那个类", async () => {
    await signIn()
    const wrapper = await mountSettings()

    // 默认「跟随系统」，并且写明此刻跟到了哪一档
    expect(wrapper.get('[data-testid="theme-system-hint"]').text()).toContain("浅色")

    await wrapper.get('[data-testid="theme-dark"]').trigger("click")
    await flushPromises()

    expect(theme.value).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    // 选了具体档位就不该再说「跟随系统」
    expect(wrapper.find('[data-testid="theme-system-hint"]').exists()).toBe(false)
  })

  it("改时区，预览里的时刻跟着换算", async () => {
    await signIn()
    displayPreferences.value.timeZone = "UTC"
    displayPreferences.value.locale = "zh-CN"
    const wrapper = await mountSettings()

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
    const wrapper = await mountSettings()

    expect(wrapper.get('[data-testid="preview-date"]').text()).not.toContain("星期")

    displayPreferences.value.dateStyle = "full"
    await flushPromises()
    expect(wrapper.get('[data-testid="preview-date"]').text()).toContain("星期")
  })

  it("预览上方写明按哪个时区、哪个语言渲染", async () => {
    await signIn()
    displayPreferences.value.timeZone = "Asia/Shanghai"
    displayPreferences.value.locale = "zh-CN"
    const wrapper = await mountSettings()

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
    const wrapper = await mountSettings()

    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(wrapper.get('[data-testid="preview-basis"]').text()).toContain(browserZone)
  })

  it("默认状态下「恢复默认」是禁用的，改过之后才能点", async () => {
    await signIn()
    const wrapper = await mountSettings()

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
