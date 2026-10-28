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
  user: null as AuthUser | null,
  /** 会话过期了，正在问用户「要不要现在去登录」——由全局的确认框渲染 */
  sessionExpired: false
})

/** 用户点「去登录」后要回到的地址；只在 requestReLogin 时记一次 */
let reLoginRedirect = "/"

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

/**
 * 登出同样是整页跳转。`returnTo` 是「退出时人在哪」：服务端把它接到登录页的
 * ?redirect= 上，所以重新登录完人回到原来那一页，而不是首页。
 */
export function startLogout(returnTo?: string) {
  const query = returnTo ? `?redirect=${encodeURIComponent(returnTo)}` : ""
  window.location.assign(`/api/auth/logout${query}`)
}

/** 当前地址（回登录页之后要跳回来的那个） */
function currentPath() {
  return window.location.pathname + window.location.search
}

/**
 * 会话过期时的统一入口：**不直接把人踢走**，先记下要回来的地址、把确认框打开。
 * 用户不选就停在原地——页面还在，没提交的内容也不会被一次跳转冲掉。
 */
export function requestReLogin(redirect = currentPath()) {
  state.user = null
  reLoginRedirect = redirect
  state.sessionExpired = true
}

/** 会话过期时记下的那个地址（内嵌登录窗、退出都要用它当回跳目标） */
export function reLoginTarget() {
  return reLoginRedirect
}

/** 「退出」：清掉会话回登录页，并把 return url 记在登录页的 ?redirect= 上 */
export function logoutFromExpired() {
  state.sessionExpired = false
  startLogout(reLoginRedirect)
}

/** 用户什么都不选（关窗 / Esc / 点遮罩）：页面原样不动；下次再有 401 会再问一遍 */
export function dismissReLogin() {
  state.sessionExpired = false
}

// ---------------------------------------------------------------- 新窗口登录

/** 登录窗口走完之后落地的服务端页面，它会 postMessage 通知开它的那一页 */
export const LOGIN_DONE_PATH = "/auth/login-done"

/** 那条消息的标记；连同 origin 一起校验，别人发的不认 */
export const LOGIN_DONE_MESSAGE = "app-auth:login-done"

/** 新开的登录窗口打开的地址 */
export function loginWindowUrl() {
  return loginUrl(LOGIN_DONE_PATH)
}

/** 登录窗口的名字：同名复用同一个窗口，连点几下不会开出一排 */
const LOGIN_WINDOW_NAME = "app-relogin"

/**
 * 开一个窗口走完整套 OIDC —— 当前页原封不动。
 * 被浏览器拦下时返回 null，由调用方提示用户。
 */
export function openLoginWindow(): Window | null {
  return window.open(loginWindowUrl(), LOGIN_WINDOW_NAME, "width=520,height=680")
}

/** 是不是那条「登录完成」的消息：同源 + 标记，两道都要过 */
export function isLoginDone(event: MessageEvent): boolean {
  if (event.origin !== window.location.origin) return false
  const data = event.data as { source?: string; type?: string } | null
  return data?.source === "app-auth" && data.type === LOGIN_DONE_MESSAGE
}

/**
 * 登录窗口里登完了：重新问一次登录态，真登上了才把提示收起来。
 * 会话是 httpOnly cookie，前端只能这样确认。
 */
export async function finishReLogin(): Promise<boolean> {
  await fetchSession(true)
  if (!state.user) return false
  state.sessionExpired = false
  return true
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
    /** 会话过期确认框的开关，只有根组件的 SessionExpiredDialog 用得上 */
    sessionExpired: computed(() => state.sessionExpired),
    hasRole: (role: string) => (state.user?.roles ?? []).includes(role),
    fetchSession,
    startLogin,
    startLogout,
    requestReLogin,
    logoutFromExpired,
    dismissReLogin,
    finishReLogin
  }
}

/**
 * 调后端接口用这个：401 说明会话没了（过期/被登出）。
 * 这里只把「要重新登录」这件事亮出来（弹确认框），跳不跳由用户决定 ——
 * 悄悄整页跳走会把用户正在填的东西一起带走，连出了什么事都看不见。
 */
export async function apiFetch(input: string, init: RequestInit = {}) {
  const res = await fetch(input, { credentials: "same-origin", ...init })
  if (res.status === 401 && state.enabled) {
    requestReLogin()
  }
  return res
}
