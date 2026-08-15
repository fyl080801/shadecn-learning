import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter, type Router } from "vue-router"
import Login from "@/views/Login.vue"
import { fetchSession } from "@/lib/auth"

let assign: ReturnType<typeof vi.fn>

/** 让 lib/auth 的模块级 state 变成想要的登录态 */
async function primeAuth(payload: { enabled?: boolean; authenticated?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            enabled: true,
            authenticated: false,
            user: null,
            expiresAt: null,
            ...payload
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    )
  )
  await fetchSession(true)
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "Home", component: { template: "<div />" } },
      { path: "/2048", name: "Game2048", component: { template: "<div />" } },
      { path: "/login", name: "Login", component: Login }
    ]
  })
}

async function mountLogin(path: string) {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  return mount(Login, { global: { plugins: [router] } })
}

beforeEach(() => {
  assign = vi.fn()
  vi.stubGlobal("location", { assign, pathname: "/login", search: "" })
})

describe("Login.vue", () => {
  it("正常渲染登录按钮", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login")

    expect(wrapper.text()).toContain("使用 Keycloak 登录")
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined()
  })

  it("点登录 → 整页跳到后端登录入口，带上 redirect", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login?redirect=/2048")

    await wrapper.find("button").trigger("click")

    expect(assign).toHaveBeenCalledWith("/api/auth/login?redirect=%2F2048")
  })

  it("没有 redirect 时默认回首页", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login")

    await wrapper.find("button").trigger("click")
    expect(assign).toHaveBeenCalledWith("/api/auth/login?redirect=%2F")
  })

  it("非站内的 redirect 被丢掉，回落到 /", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login?redirect=https://evil.example")

    await wrapper.find("button").trigger("click")
    expect(assign).toHaveBeenCalledWith("/api/auth/login?redirect=%2F")
  })

  it("点过之后按钮变成「正在跳转」并禁用，防止连点", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login")

    await wrapper.find("button").trigger("click")

    expect(wrapper.text()).toContain("正在跳转 Keycloak")
    expect(wrapper.find("button").attributes("disabled")).toBeDefined()
  })

  it("?error= 会原样显示在页面上", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin(
      `/login?error=${encodeURIComponent("state 校验失败")}`
    )

    expect(wrapper.text()).toContain("state 校验失败")
  })

  it("没有 error 时不显示错误条", async () => {
    await primeAuth({ enabled: true })
    const wrapper = await mountLogin("/login")

    expect(wrapper.text()).not.toContain("state 校验失败")
    expect(wrapper.find(".text-destructive").exists()).toBe(false)
  })

  it("后端没配 Keycloak 时给出提示，并把登录按钮禁掉", async () => {
    await primeAuth({ enabled: false })
    const wrapper = await mountLogin("/login")

    expect(wrapper.text()).toContain("没有配置 Keycloak")
    expect(wrapper.find("button").attributes("disabled")).toBeDefined()
  })
})
