import { computed, reactive } from "vue"

/**
 * 前端这边没有 token —— 登录态全靠后端那只 httpOnly 的 sid cookie。
 * 这里只负责：问一次 /api/auth/me，把结果放进一个响应式对象。
 */

export interface AuthUser {
  id: string
  subject: string
  username: string | null
  email: string | null
  name: string | null
  avatarUrl: string | null
  roles: string[]
}

interface MeResponse {
  enabled: boolean
  authenticated: boolean
  user: AuthUser | null
  expiresAt: string | null
}

const state = reactive({
  /** 后端有没有配 Keycloak；没配就整站放行 */
  enabled: true,
  /** 是否已经问过后端 */
  ready: false,
  user: null as AuthUser | null
})

let inflight: Promise<void> | null = null

async function load() {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
    if (!res.ok) throw new Error(`/api/auth/me ${res.status}`)
    const data = (await res.json()) as MeResponse
    state.enabled = data.enabled
    state.user = data.authenticated ? data.user : null
  } catch (err) {
    console.error("[auth] 获取登录态失败", err)
    state.user = null
  } finally {
    state.ready = true
  }
}

/** 拿登录态：默认只请求一次，force 用于登出后刷新 */
export function fetchSession(force = false): Promise<void> {
  if (force) {
    state.ready = false
    inflight = null
  }
  if (state.ready && !inflight) return Promise.resolve()
  inflight ??= load().finally(() => {
    inflight = null
  })
  return inflight
}

export function loginUrl(redirect = "/") {
  return `/api/auth/login?redirect=${encodeURIComponent(redirect)}`
}

/**
 * 登录页是服务端渲染的（不是 SPA 路由），所以只能整页跳过去。
 */
export function goToLoginPage(redirect = "/") {
  window.location.replace(`/login?redirect=${encodeURIComponent(redirect)}`)
}

/** 登录/登出都是整页跳转：要经过 Keycloak，SPA 内部跳没用 */
export function startLogin(redirect = "/") {
  window.location.assign(loginUrl(redirect))
}

export function startLogout() {
  window.location.assign("/api/auth/logout")
}

export function useAuth() {
  return {
    user: computed(() => state.user),
    roles: computed(() => state.user?.roles ?? []),
    displayName: computed(
      () => state.user?.name ?? state.user?.username ?? state.user?.email ?? "未登录"
    ),
    isAuthenticated: computed(() => Boolean(state.user)),
    authEnabled: computed(() => state.enabled),
    ready: computed(() => state.ready),
    hasRole: (role: string) => (state.user?.roles ?? []).includes(role),
    fetchSession,
    startLogin,
    startLogout
  }
}

/**
 * 调后端接口用这个：401 说明会话没了（过期/被登出），
 * 直接把人送回登录页，省得每个调用点自己判断。
 */
export async function apiFetch(input: string, init: RequestInit = {}) {
  const res = await fetch(input, { credentials: "same-origin", ...init })
  if (res.status === 401 && state.enabled) {
    state.user = null
    startLogin(window.location.pathname + window.location.search)
  }
  return res
}
