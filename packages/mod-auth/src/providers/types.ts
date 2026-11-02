/**
 * 身份提供方的统一形状。
 *
 * 加一个登录方式 = 新写一个实现 + 在 `providers/index.ts` 里登记一行，
 * 路由（`routes/auth.ts`）、会话（`auth/session.ts`）、登录页都不用认识它是谁。
 *
 * 两家的差别全部收在实现里：Keycloak 是 OIDC（discovery / PKCE / id_token / JWKS /
 * refresh_token），GitHub 是**光秃秃的 OAuth2**（没有 discovery、没有 id_token、
 * 身份要再调一次 `/user`、OAuth App 的 token 不会过期也没有 refresh_token）。
 */

import type { ProviderProfile, ProviderTokens } from '@shadecn/server-kit/oauth'
import type { ProviderId } from '@shadecn/shared/auth'

/**
 * 提供方 id。同时是 `UserIdentity.provider` 的取值和登录 URL 上的 `?provider=`。
 * 声明在 `@shadecn/shared/auth`（前端登录页认的是同一份），这里转出去。
 */
export type { ProviderId }

// 形状在 `@shadecn/server-kit/oauth`，@learning/session 也用同一份
export type { ProviderProfile, ProviderTokens }

export interface AuthorizeInput {
  state: string
  /** OIDC 用；GitHub 忽略 */
  nonce: string
  /** PKCE 的原文，provider 自己决定要不要算 challenge */
  codeVerifier: string
  /**
   * 这一趟用哪个回调地址。**按访问的域名算出来的**（见 `auth/origin.ts`），
   * 不是一个全局常量 —— 同一套部署挂在多个域名下时，从哪个域名进来就得回到哪个域名，
   * 否则会话 cookie 会种到另一个域名上。取值范围由 `SERVER_ORIGINS` 白名单收口。
   */
  redirectUri: string
}

export interface ExchangeInput {
  code: string
  codeVerifier: string
  nonce: string
  /**
   * 换 token 时带的 `redirect_uri`，**必须和授权那一步一模一样** —— OAuth2 要求
   * 逐字符相等，对不上提供方会直接回绝。所以它是从 `AuthRequest.origin` 读回来的，
   * 而不是回调这一趟重新算一遍。
   */
  redirectUri: string
}

export interface ExchangeResult {
  profile: ProviderProfile
  tokens: ProviderTokens
}

export interface AuthProvider {
  id: ProviderId
  /** 提供方名字，设置页的「登录方式」列表里显示这个 */
  label: string
  /** 登录页按钮上的字 */
  buttonLabel: string
  /** 配齐了没有；没配的提供方不出现在登录页，直接访问它的 URL 也会被挡 */
  readonly enabled: boolean
  /** 把浏览器送去哪儿 */
  authorizationUrl(input: AuthorizeInput): Promise<string>
  /** code 换 token + 读身份 */
  exchange(input: ExchangeInput): Promise<ExchangeResult>
  /**
   * 续期。`null` = 这个提供方的 token 根本不会过期（GitHub 的 OAuth App
   * 就是这样），会话靠自己的 `MODULES_AUTH_SESSION_TTL` 到期，不需要也没法续。
   */
  refresh: ((refreshToken: string) => Promise<{ tokens: ProviderTokens; roles: string[] }>) | null
}
