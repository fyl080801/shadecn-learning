/**
 * 登录相关的接口形状与常量 —— 服务端产出、前端消费的同一份（docs/02-auth-keycloak.md）。
 */

/** 登录方式。加一种 = 服务端 `apps/server/auth/providers/` 多一个实现 + 这里多一个值 */
export type ProviderId = 'keycloak' | 'github'

/** `/api/auth/config` 里列出的可用登录方式（不含任何配置细节）；数组顺序就是登录页按钮顺序 */
export interface ProviderView {
  id: ProviderId
  label: string
  buttonLabel: string
}

/** 设置页「登录方式」列表里的一行（`GET /api/auth/identities`） */
export interface IdentityView {
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
 * 一条**等着用户确认**的关联 —— 确认框上要显示的东西，用户要靠它看清自己绑的是哪个账号。
 *
 * 第三方授权回来之后不直接落库 —— 先把「你要关联的是谁」摆出来。
 * 提供方那边可能正登着别人的账号，而且授权过一次之后连确认页都不再弹，
 * 整趟对用户是无感的，所以这一问只能由我们来问。
 *
 * 只放**界面真的会显示**的字段。过期时刻不在里面：界面上不写倒计时，
 * 真放过期了确认接口会回 410 并说清楚，没必要多送一个没人读的值出去。
 */
export interface PendingLinkView {
  provider: ProviderId
  label: string
  username: string | null
  email: string | null
  avatarUrl: string | null
}

// —— 新窗口重新登录 ——

/**
 * 「重新登录」开的那个窗口走完 OIDC 之后落地的路径。
 * 服务端在这里渲染一张自包含的小页面（`apps/server/frontend/login-done-page.ts`），
 * 它 postMessage 通知开它的那一页，然后把自己关掉。
 */
export const LOGIN_DONE_PATH = '/auth/login-done'

/** 那条 postMessage 的 `source` 字段 */
export const LOGIN_DONE_SOURCE = 'app-auth'

/** 那条 postMessage 的 `type` 字段；前端连同 origin 一起校验，别人发的不认 */
export const LOGIN_DONE_MESSAGE = 'app-auth:login-done'
