import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Router } from "vue-router"

/**
 * 路由守卫用的是真实的 router 和真实的 lib/auth，只把 /api/auth/me 打桩，
 * 这样「登录态怎么来的」和「守卫怎么判的」是一起被约束住的。
 */
interface MePayload {
  enabled?: boolean
  authenticated?: boolean
  user?: unknown
}

const alice = {
  id: "u1",
  subject: "s1",
  username: "alice",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
  roles: ["admin"]
}

async function loadRouter(payload: MePayload = {}): Promise<Router> {
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
  vi.resetModules()
  return (await import("@/router")).default
}

const anonymous = () => loadRouter()
const loggedIn = () => loadRouter({ authenticated: true, user: alice })

beforeEach(() => {
  // 每个用例都从 / 开始，避免上一个用例把地址栏留在了别处
  window.history.replaceState({}, "", "/")
})

describe("未登录时", () => {
  it("访问受保护页面被送去登录页，并记下原地址", async () => {
    const router = await anonymous()
    await router.push("/2048")

    expect(router.currentRoute.value.name).toBe("Login")
    expect(router.currentRoute.value.query.redirect).toBe("/2048")
  })

  it("带 query 的地址也完整记下来（用的是 fullPath）", async () => {
    const router = await anonymous()
    await router.push("/snake?level=3")

    expect(router.currentRoute.value.query.redirect).toBe("/snake?level=3")
  })

  it("登录页本身是 public，直接能打开", async () => {
    const router = await anonymous()
    await router.push("/login")

    expect(router.currentRoute.value.name).toBe("Login")
  })

  it("只问一次 /api/auth/me，之后的导航走缓存", async () => {
    const router = await anonymous()
    await router.push("/2048")
    await router.push("/snake")
    await router.push("/")

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe("已登录时", () => {
  it("受保护页面正常进入", async () => {
    const router = await loggedIn()
    await router.push("/2048")

    expect(router.currentRoute.value.name).toBe("Game2048")
  })

  it("再去登录页会被弹回首页", async () => {
    const router = await loggedIn()
    await router.push("/login")

    expect(router.currentRoute.value.path).toBe("/")
  })

  it("带 redirect 的登录页会跳回那个地址", async () => {
    const router = await loggedIn()
    await router.push("/login?redirect=/2048")

    expect(router.currentRoute.value.name).toBe("Game2048")
  })

  it("登录页上非站内的 redirect 被忽略，回首页", async () => {
    const router = await loggedIn()
    await router.push("/login?redirect=https%3A%2F%2Fevil.example")

    expect(router.currentRoute.value.path).toBe("/")
  })

  it("协议相对地址跳不出本站（vue-router 当成站内路径解析）", async () => {
    const router = await loggedIn()
    await router.push("/login?redirect=%2F%2Fevil.example%2Fpwn")

    // 真正的 open redirect 防线在后端 safeRedirect；这里保证前端也没把人送出去
    expect(window.location.origin).toBe("http://localhost:3000")
    expect(router.currentRoute.value.fullPath.startsWith("http")).toBe(false)
  })
})

describe("后端没配 Keycloak 时", () => {
  it("整站放行，不再往登录页赶", async () => {
    const router = await loadRouter({ enabled: false })
    await router.push("/2048")

    expect(router.currentRoute.value.name).toBe("Game2048")
  })

  it("登录页也还能打开（页面上会提示没配）", async () => {
    const router = await loadRouter({ enabled: false })
    await router.push("/login")

    expect(router.currentRoute.value.name).toBe("Login")
  })
})

describe("路由表约定", () => {
  it("只有 /login 是免登录的，其余都要登录", async () => {
    const router = await anonymous()
    const publicRoutes = router
      .getRoutes()
      .filter((r) => r.meta.public)
      .map((r) => r.path)

    expect(publicRoutes).toEqual(["/login"])
  })

  it("/login 用 blank 布局（不套侧边栏）", async () => {
    const router = await anonymous()
    const login = router.getRoutes().find((r) => r.name === "Login")

    expect(login?.meta.layout).toBe("blank")
  })

  it("其它页面都不设 layout，走默认的侧边栏布局", async () => {
    const router = await anonymous()
    const withLayout = router
      .getRoutes()
      .filter((r) => r.meta.layout !== undefined)
      .map((r) => r.name)

    expect(withLayout).toEqual(["Login"])
  })
})
