/**
 * 登录相关的接口类型。
 *
 * 和 `server/store/identities.ts` / `server/auth/providers/types.ts` 互为镜像 ——
 * `server/` 和 `src/` 是两个独立的 TS 工程，改一边就要改另一边。
 */

export type ProviderId = "keycloak" | "github"

/** 设置页「登录方式」列表里的一行 */
export interface AuthIdentity {
  id: string
  provider: ProviderId
  /** 提供方显示名（'Keycloak' / 'GitHub'） */
  label: string
  username: string | null
  email: string | null
  avatarUrl: string | null
  createdAt: string
  lastLoginAt: string | null
  /**
   * 主身份：用户档案（显示名、头像）跟着它走。
   * 解绑它会把剩下的第一条提升上来，不是不让解。
   */
  primary: boolean
}

/**
 * 一条**等着用户确认**的关联。
 *
 * 第三方授权回来之后不直接落库 —— 先把「你要关联的是谁」摆出来。
 * 提供方那边可能正登着别人的账号，而且授权过一次之后连确认页都不再弹，
 * 整趟对用户是无感的，所以这一问只能由我们来问。
 */
export interface PendingLink {
  provider: ProviderId
  label: string
  username: string | null
  email: string | null
  avatarUrl: string | null
}

/** `/api/auth/config` 里列出的可用登录方式 */
export interface AuthProviderView {
  id: ProviderId
  label: string
  buttonLabel: string
}
