import type { Context } from 'hono'
import { platform } from '@shadecn/server-kit/platform'
import type { AuthSettings } from './config.ts'

/**
 * 登录模块解析好的配置，模块 `setup` 时交进来（{@link configureAuthSettings}）。
 *
 * 用 `export let` 导出：ES 模块的导出是**活绑定**，各文件 `import { authConfig, authEnabled }` 拿到的始终是交进来之后的值 ——
 * 所以登录代码里照旧按名字读这几项，不必每处都改成函数调用。**只在请求 / 调用时读，不要在 import 时读**（那时还没交进来）。
 */

/** Keycloak（OIDC）+ 会话的配置；`cookieName` / `txCookieName` 是固定的 */
export let authConfig = {
  issuer: '',
  clientId: '',
  clientSecret: '',
  scope: 'openid profile email',
  /** 会话 cookie 名 */
  cookieName: 'sid',
  /** 授权过程中的临时 cookie 名 */
  txCookieName: 'oidc_tx',
  /** 会话最长存活时间（秒） */
  ttl: 7 * 24 * 3600,
  /** 会话 token 做 HMAC 的密钥 */
  secret: '',
}

/** GitHub OAuth App；`issuer` 是落进 User.issuer / UserIdentity.issuer 的固定值 */
export let githubConfig = { clientId: '', clientSecret: '', scope: 'read:user user:email', issuer: 'https://github.com' }

export let keycloakEnabled = false
export let githubEnabled = false
/** 一个提供方都没配就退化成「不鉴权」，方便本地只跑前端 demo；生产必须至少配一个（解析配置时校验） */
export let authEnabled = false

export function configureAuthSettings(settings: AuthSettings): void {
  authConfig = { ...authConfig, ...settings.keycloak, ttl: settings.ttl, secret: settings.secret }
  githubConfig = { ...githubConfig, ...settings.github }
  keycloakEnabled = settings.keycloakEnabled
  githubEnabled = settings.githubEnabled
  authEnabled = settings.enabled
}

/** 这次请求认哪个对外地址（平台的对外域名白名单） */
export function originOf(c: Context): string {
  return platform().origins.of(c)
}

/** 登出后回到的前端地址 */
export function postLogoutRedirectUri(): string {
  return `${platform().origins.primary}/login`
}

/** 某个 origin 下的 OAuth 回调地址。回调只有这一个路径，靠 `AuthRequest.provider` 分发 */
export function callbackUriFor(origin: string) {
  return `${origin}/api/auth/callback`
}

/**
 * 这个 origin 下的 cookie 该不该带 Secure —— 按**这次请求的域名**算，不是按 `SERVER_ORIGIN` 一刀切：
 * 白名单里可以同时有 http 和 https 的域名，一刀切的话 https 那边漏了 Secure、http 那边 cookie 直接种不下去
 * （表现为「登录成功但还是未登录」）。
 */
export function secureCookieFor(origin: string) {
  return origin.startsWith('https://')
}
