import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import LoginPage from "@/login/LoginPage.vue"
import type { AuthProviderView } from "@/types/auth"

/**
 * 登录页。它是 `login.html` 这个第二入口挂载的独立应用，不是 SPA 的路由 ——
 * 未登录时后端根本不发 `index.html`，登录页不能长在需要它才能启动的那棵树上。
 *
 * 页面要的三样东西都不靠服务端注入：登录方式来自 `/api/auth/config`，
 * `?redirect=` / `?error=` 来自地址栏。
 */

const KEYCLOAK: AuthProviderView = {
  id: "keycloak",
  label: "Keycloak",
  buttonLabel: "使用 Keycloak 登录"
}
const GITHUB: AuthProviderView = {
  id: "github",
  label: "GitHub",
  buttonLabel: "使用 GitHub 登录"
}

function stubConfig(body: unknown) {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" }
      })
    )
  )
}

/** 页面从 location.search 读参数，jsdom 里改地址栏 */
function visit(search = "") {
  window.history.replaceState({}, "", `/login${search}`)
}

beforeEach(() => visit())
afterEach(() => visit())

async function mountPage(providers: AuthProviderView[] = [KEYCLOAK], enabled = true) {
  stubConfig({ enabled, providers })
  const wrapper = mount(LoginPage)
  await flushPromises()
  return wrapper
}

describe("登录页", () => {
  it("每个启用的提供方一个入口，链接带上 provider 和 redirect", async () => {
    visit("?redirect=%2F2048")
    const wrapper = await mountPage([KEYCLOAK, GITHUB])

    expect(wrapper.get('[data-testid="login-keycloak"]').attributes("href")).toBe(
      `/api/auth/login?provider=keycloak&redirect=${encodeURIComponent("/2048")}`
    )
    expect(wrapper.get('[data-testid="login-github"]').attributes("href")).toBe(
      `/api/auth/login?provider=github&redirect=${encodeURIComponent("/2048")}`
    )
  })

  it("没配 GitHub 时就没有它的入口", async () => {
    const wrapper = await mountPage([KEYCLOAK])
    expect(wrapper.find('[data-testid="login-github"]').exists()).toBe(false)
  })

  it("入口是 <a>，不是要靠 JS 才能点的按钮", async () => {
    const wrapper = await mountPage([KEYCLOAK])
    expect(wrapper.get('[data-testid="login-keycloak"]').element.tagName).toBe("A")
  })

  it("只有一种方式时副标题点名是哪一种，多种时让人选", async () => {
    expect((await mountPage([KEYCLOAK])).text()).toContain("用Keycloak账号继续")
    expect((await mountPage([KEYCLOAK, GITHUB])).text()).toContain("选一种方式继续")
  })

  /**
   * 以前这一页是服务端拼字符串，`?error=` 要手写 escapeHtml。
   * 现在走文本插值，转义是 Vue 的事 —— 这条钉的就是「注入不进去」。
   */
  it("?error= 原样显示，且注入不进 DOM", async () => {
    visit(`?error=${encodeURIComponent("<img src=x onerror=alert(1)>失败了")}`)
    const wrapper = await mountPage()

    const banner = wrapper.get('[data-testid="login-error"]')
    expect(banner.text()).toContain("<img src=x onerror=alert(1)>失败了")
    expect(banner.find("img").exists()).toBe(false)
  })

  it("没有 ?error= 就不显示错误条", async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid="login-error"]').exists()).toBe(false)
  })

  it("服务端一个登录方式都没配 → 说清楚，而不是给个点了没反应的按钮", async () => {
    const wrapper = await mountPage([], false)

    expect(wrapper.get('[data-testid="login-disabled"]').text()).toContain("没有配置")
    expect(wrapper.find('[data-testid="login-keycloak"]').exists()).toBe(false)
  })

  it("读不到配置时也不留半个空页面", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")))
    vi.spyOn(console, "error").mockImplementation(() => {})

    const wrapper = mount(LoginPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="login-disabled"]').exists()).toBe(true)
  })
})
