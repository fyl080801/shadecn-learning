import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * lib/auth.ts 的登录态是模块级单例（reactive state + inflight），
 * 每个用例都要 resetModules 重新 import 才互不干扰。
 */
type AuthModule = typeof import("@/lib/auth")

interface MePayload {
  enabled?: boolean
  authenticated?: boolean
  user?: unknown
  expiresAt?: string | null
}

let fetchMock: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>

const meResponse = (payload: MePayload = {}, status = 200) =>
  new Response(
    JSON.stringify({
      enabled: true,
      authenticated: false,
      user: null,
      expiresAt: null,
      ...payload
    }),
    { status, headers: { "content-type": "application/json" } }
  )

const alice = {
  id: "u1",
  subject: "s1",
  username: "alice",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
  roles: ["admin", "user"]
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(meResponse()))
  vi.stubGlobal("fetch", fetchMock)

  assign = vi.fn()
  vi.stubGlobal("location", {
    assign,
    pathname: "/2048",
    search: "?a=1",
    href: "http://localhost/2048?a=1"
  })
})

async function loadAuth(payload?: MePayload, status?: number): Promise<AuthModule> {
  if (payload || status) {
    fetchMock.mockResolvedValue(meResponse(payload ?? {}, status ?? 200))
  }
  vi.resetModules()
  return import("@/lib/auth")
}

describe("fetchSession()", () => {
  it("问一次 /api/auth/me，带上同源 cookie", async () => {
    const { fetchSession } = await loadAuth()
    await fetchSession()

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
  })

  it("默认只请求一次，后面直接用缓存", async () => {
    const { fetchSession } = await loadAuth()
    await fetchSession()
    await fetchSession()
    await fetchSession()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("并发调用共享同一个在途请求", async () => {
    const { fetchSession } = await loadAuth()
    await Promise.all([fetchSession(), fetchSession(), fetchSession()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("force=true 会重新问一次（登出后刷新用）", async () => {
    const { fetchSession } = await loadAuth()
    await fetchSession()
    await fetchSession(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("已登录时把用户放进 state", async () => {
    const { fetchSession, useAuth } = await loadAuth({
      authenticated: true,
      user: alice
    })
    await fetchSession()

    const { user, isAuthenticated, roles, ready } = useAuth()
    expect(isAuthenticated.value).toBe(true)
    expect(user.value?.username).toBe("alice")
    expect(roles.value).toEqual(["admin", "user"])
    expect(ready.value).toBe(true)
  })

  it("authenticated=false 时即使带了 user 也当没登录", async () => {
    const { fetchSession, useAuth } = await loadAuth({
      authenticated: false,
      user: alice
    })
    await fetchSession()

    expect(useAuth().user.value).toBeNull()
  })

  it("后端没配 Keycloak 时 authEnabled=false", async () => {
    const { fetchSession, useAuth } = await loadAuth({ enabled: false })
    await fetchSession()

    expect(useAuth().authEnabled.value).toBe(false)
  })

  it.each([
    ["接口返回 500", { status: 500 }],
    ["接口返回 401", { status: 401 }]
  ])("%s → 当作未登录，且不卡住 ready", async (_label, { status }) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { fetchSession, useAuth } = await loadAuth({}, status)
    await fetchSession()

    const { user, ready } = useAuth()
    expect(user.value).toBeNull()
    expect(ready.value).toBe(true)
  })

  it("网络断了也要把 ready 置上，否则路由守卫会一直挂着", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    fetchMock.mockRejectedValue(new Error("offline"))
    vi.resetModules()
    const { fetchSession, useAuth } = (await import("@/lib/auth")) as AuthModule

    await expect(fetchSession()).resolves.toBeUndefined()
    expect(useAuth().ready.value).toBe(true)
  })
})

describe("useAuth() 派生状态", () => {
  it.each([
    ["有 name 就用 name", { ...alice }, "Alice"],
    ["没 name 用 username", { ...alice, name: null }, "alice"],
    [
      "都没有就用 email",
      { ...alice, name: null, username: null },
      "alice@example.com"
    ],
    [
      "什么都没有显示「未登录」",
      { ...alice, name: null, username: null, email: null },
      "未登录"
    ]
  ])("displayName：%s", async (_label, user, expected) => {
    const { fetchSession, useAuth } = await loadAuth({
      authenticated: true,
      user
    })
    await fetchSession()

    expect(useAuth().displayName.value).toBe(expected)
  })

  it("没登录时 displayName 是「未登录」，roles 是空数组", async () => {
    const { fetchSession, useAuth } = await loadAuth()
    await fetchSession()

    expect(useAuth().displayName.value).toBe("未登录")
    expect(useAuth().roles.value).toEqual([])
  })

  it("hasRole 判断当前用户角色", async () => {
    const { fetchSession, useAuth } = await loadAuth({
      authenticated: true,
      user: alice
    })
    await fetchSession()

    const { hasRole } = useAuth()
    expect(hasRole("admin")).toBe(true)
    expect(hasRole("nope")).toBe(false)
  })

  it("没登录时 hasRole 一律 false，不抛异常", async () => {
    const { useAuth } = await loadAuth()
    expect(useAuth().hasRole("admin")).toBe(false)
  })
})

describe("登录 / 登出跳转", () => {
  it("loginUrl 对 redirect 做 URL 编码", async () => {
    const { loginUrl } = await loadAuth()

    expect(loginUrl("/2048?x=1&y=2")).toBe(
      "/api/auth/login?redirect=%2F2048%3Fx%3D1%26y%3D2"
    )
    expect(loginUrl()).toBe("/api/auth/login?redirect=%2F")
  })

  it("startLogin 是整页跳转（要经过 Keycloak，SPA 内部跳没用）", async () => {
    const { startLogin } = await loadAuth()
    startLogin("/2048")

    expect(assign).toHaveBeenCalledWith("/api/auth/login?redirect=%2F2048")
  })

  it("startLogout 整页跳到后端登出入口", async () => {
    const { startLogout } = await loadAuth()
    startLogout()

    expect(assign).toHaveBeenCalledWith("/api/auth/logout")
  })
})

describe("apiFetch()", () => {
  it("默认带 same-origin cookie", async () => {
    const { apiFetch } = await loadAuth()
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))

    await apiFetch("/api/notes")
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", {
      credentials: "same-origin"
    })
  })

  it("调用方自己的 init 会合并进去", async () => {
    const { apiFetch } = await loadAuth()
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))

    await apiFetch("/api/notes", { method: "POST", body: "{}" })
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", {
      credentials: "same-origin",
      method: "POST",
      body: "{}"
    })
  })

  it("401 说明会话没了 → 清掉本地用户并跳登录页，带上当前地址", async () => {
    const { apiFetch, fetchSession, useAuth } = await loadAuth({
      authenticated: true,
      user: alice
    })
    await fetchSession()
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }))

    await apiFetch("/api/notes")

    expect(useAuth().isAuthenticated.value).toBe(false)
    expect(assign).toHaveBeenCalledWith(
      `/api/auth/login?redirect=${encodeURIComponent("/2048?a=1")}`
    )
  })

  it("后端没开登录时，401 不该把人踢去登录页", async () => {
    const { apiFetch, fetchSession } = await loadAuth({ enabled: false })
    await fetchSession()
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }))

    await apiFetch("/api/notes")
    expect(assign).not.toHaveBeenCalled()
  })

  it("非 401 原样把 Response 交回调用方", async () => {
    const { apiFetch } = await loadAuth()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const res = await apiFetch("/api/notes")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(assign).not.toHaveBeenCalled()
  })

  it("403 不触发跳转（是权限不够，不是没登录）", async () => {
    const { apiFetch } = await loadAuth()
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }))

    await apiFetch("/api/admin")
    expect(assign).not.toHaveBeenCalled()
  })
})
