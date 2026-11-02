/**
 * 登录协议层的共用形状和错误类型：`@shadecn/mod-auth` 和 `@learning/session` 用同一份，
 * 这样「这个人是谁」「落进 Session 行的是什么」「失败了算不算凭证失效」两边只有一种答案。
 */

/** 从提供方那边读回来的这个人是谁 */
export interface ProviderProfile {
  /** 提供方内部的用户标识：OIDC 的 `sub`、GitHub 的数字 id */
  subject: string
  /** 提供方的 issuer；GitHub 没有这个概念，用固定的 https://github.com */
  issuer: string
  username: string | null
  /** 只是档案字段。**邮箱不参与身份判断**，理由见 `packages/mod-auth/src/login-identity.ts` */
  email: string | null
  name: string | null
  avatarUrl: string | null
  /** 角色。只有 OIDC 给得出来，GitHub 一律空数组 */
  roles: string[]
}

/** 落进 Session 行的那几样东西。到期时间已经算成绝对时刻，调用方不用再换算 */
export interface ProviderTokens {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresAt: Date
  refreshExpiresAt: Date | null
  sessionState: string | null
}

export interface OidcErrorInit {
  /** 提供方回的 OAuth 错误码，refresh token 真失效时是 `invalid_grant` */
  code?: string
  /**
   * 连不上、超时、对方 5xx —— 这次没问出结果，不代表凭证没了。
   * 调用方据此决定是重试还是销毁会话。
   */
  retryable?: boolean
  cause?: unknown
}

/**
 * 名字叫 Oidc，实际是**所有身份提供方共用**的错误类型（GitHub 那条路也抛它）：
 * 会话的重试逻辑只认 `retryable` 这一个字段，两家共用一个类型才不用在那边分叉判断。
 */
export class OidcError extends Error {
  readonly code: string | undefined
  readonly retryable: boolean

  constructor(message: string, init: OidcErrorInit = {}) {
    super(message, { cause: init.cause })
    this.name = 'OidcError'
    this.code = init.code
    this.retryable = init.retryable ?? false
  }
}

/** 出站请求超时：node 的 fetch 默认不超时，提供方卡住会把请求一起挂死 */
export const HTTP_TIMEOUT = 8000
