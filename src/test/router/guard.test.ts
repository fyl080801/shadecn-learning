import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Router } from "vue-router"

/**
 * 路由守卫用的是真实的 router 和真实的 lib/auth，只把 /api/auth/me 打桩，
 * 这样「登录态怎么来的」和「守卫怎么判的」是一起被约束住的。
 *
 * 注意：未登录的第一道闸门在服务端（server/frontend/guard.ts），未登录压根
 * 拿不到这份 bundle。这里测的是会话中途失效的兜底：整页跳到 /login。
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

let replace: ReturnType<typeof vi.fn>

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

  replace = vi.fn()
  vi.stubGlobal("location", {
    replace,
    assign: vi.fn(),
    origin: "http://localhost:3000",
    href: "http://localhost:3000/",
    pathname: "/",
    search: "",
    hash: ""
  })
})

describe("会话失效时", () => {
  it("导航被拦下，整页跳到服务端登录页并带上原地址", async () => {
    const router = await anonymous()
    await router.push("/2048")

    expect(replace).toHaveBeenCalledWith("/login?redirect=%2F2048")
    expect(router.currentRoute.value.path).toBe("/")
  })

  it("带 query 的地址也完整记下来（用的是 fullPath）", async () => {
    const router = await anonymous()
    await router.push("/snake?level=3")

    expect(replace).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent("/snake?level=3")}`
    )
  })

  it("人已经在应用里了：不直接跳走，停在当前页弹确认框", async () => {
    const router = await loggedIn()
    await router.push("/2048")

    // 会话中途失效：下一次问 /api/auth/me 就没人了
    const auth = await import("@/lib/auth")
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              enabled: true,
              authenticated: false,
              user: null,
              expiresAt: null
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      )
    )
    await auth.fetchSession(true)

    await router.push("/snake")

    expect(auth.useAuth().sessionExpired.value).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe("/2048")
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
  it("受保护页面正常进入，不跳登录页", async () => {
    const router = await loggedIn()
    await router.push("/2048")

    expect(router.currentRoute.value.name).toBe("Game2048")
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("后端没配 Keycloak 时", () => {
  it("整站放行，不再往登录页赶", async () => {
    const router = await loadRouter({ enabled: false })
    await router.push("/2048")

    expect(router.currentRoute.value.name).toBe("Game2048")
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("路由表约定", () => {
  it("SPA 里没有 /login —— 登录页由服务端模板渲染", async () => {
    const router = await anonymous()

    expect(router.getRoutes().some((r) => r.path === "/login")).toBe(false)
  })

  it("带菜单与不带菜单由模板页区分：普通页面套 SidebarLayout", async () => {
    const router = await loggedIn()
    const { default: SidebarLayout } = await import(
      "@/layouts/SidebarLayout.vue"
    )

    const matched = router.resolve("/projects").matched

    expect(matched).toHaveLength(2)
    expect(matched[0]?.components?.default).toBe(SidebarLayout)
  })

  it("两张模板页都占着 '/'，根路径仍然落在首页而不是空布局上", async () => {
    const router = await loggedIn()

    expect(router.resolve("/").name).toBe("Home")
  })

  it("画布编辑器套的是 BlankLayout —— 整屏、无侧栏", async () => {
    const router = await loggedIn()
    const { default: BlankLayout } = await import("@/layouts/BlankLayout.vue")

    const matched = router.resolve("/flows/f1").matched

    expect(matched).toHaveLength(2)
    expect(matched[0]?.components?.default).toBe(BlankLayout)
  })
})
