import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { createdAtColumn, idColumn, updatedAtColumn } from './columns.ts'

// 登录与会话相关的实体（REQ-AUTH）。
//
// 写实体的规矩（只用五种类型、字符串一律 text、时刻默认值在应用里给）见 ./columns.ts 的头注释，
// 为什么这么定见 docs/05-data-persistence.md。表名列名走 MikroORM 默认的 UnderscoreNamingStrategy：
// `UserIdentity` → `user_identity`，`avatarUrl` → `avatar_url`，关系 `user` → 外键列 `user_id`。

/**
 * 用户档案。档案字段来自**主身份**那个提供方（Keycloak 的 id_token / GitHub 的 /user）。
 *
 * `(issuer, subject)` 仍然是唯一键，但它的含义是**主身份的冗余副本** ——
 * 真正的绑定清单在 `UserIdentity` 里，一个人可以绑多条。留着这两列有两个理由：
 * 默认头像的种子是按 (issuer, subject) 算的（换主身份不该换掉那张图）、
 * 无 Keycloak 的本地开发用户还靠它找回自己。
 * 解绑主身份时会把另一条身份提升上来，一并改写这两列（见 apps/server/store/identities.ts）。
 */
export const User = defineEntity({
  name: 'User',
  properties: {
    id: idColumn(),
    issuer: p.text(),
    subject: p.text(),
    username: p.text().strictNullable(),
    email: p.text().strictNullable(),
    name: p.text().strictNullable(),
    avatarUrl: p.text().strictNullable(),
    /** Keycloak realm/client 角色，存成 JSON 字符串（不用数据库的数组 / JSON 类型，两边统一） */
    roles: p.text().default('[]'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    lastLoginAt: p.datetime().strictNullable(),
  },
  uniques: [{ properties: ['issuer', 'subject'] }],
})
export type User = InferEntity<typeof User>

/**
 * 一条「登录方式」：某个身份提供方上的账号，绑在某个本地用户身上。
 *
 * `(provider, subject)` 唯一 —— 同一个 GitHub 账号只能绑给一个人，
 * 这条约束就是「关联账号」冲突检测的全部依据，不靠应用层先查后写。
 * 一个人可以有多条（Keycloak + GitHub），至少要留一条，最后一条不许解绑。
 *
 * Prisma 时代这里还有一列没人读写的 `emailVerified`（同邮箱自动合号撤掉后的遗留，
 * 留着只是为了不让 `db push` 变成破坏性变更）。换成 MikroORM 是全新建表，顺手去掉了。
 */
export const UserIdentity = defineEntity({
  name: 'UserIdentity',
  properties: {
    id: idColumn(),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /** 提供方 id：`keycloak` / `github`（对应 apps/server/auth/providers 的注册表） */
    provider: p.text(),
    /** 提供方内部的用户标识：Keycloak 的 `sub`、GitHub 的数字 id */
    subject: p.text(),
    /**
     * 提供方的 issuer：Keycloak 是 realm 地址，GitHub 固定 https://github.com。
     * 和 User 上那两列配套，解绑主身份时要拿它改写
     */
    issuer: p.text(),
    /**
     * 这三个只用于设置页展示「这条绑的是哪个账号」，**不参与任何身份判断** ——
     * 判断只认 (provider, subject)。邮箱是属性不是身份：它会变、会被回收再分配，
     * Sign in with Apple 那类还会逐应用发不同的私有转发地址
     */
    username: p.text().strictNullable(),
    email: p.text().strictNullable(),
    avatarUrl: p.text().strictNullable(),
    createdAt: createdAtColumn(),
    lastLoginAt: p.datetime().strictNullable(),
  },
  uniques: [{ properties: ['provider', 'subject'] }],
  indexes: [{ properties: ['user'] }],
})
export type UserIdentity = InferEntity<typeof UserIdentity>

/**
 * 服务端会话：浏览器只拿到一个随机 token（httpOnly cookie），
 * 这里存的 id 是那个 token 的 HMAC，token 本身不落库。
 *
 * **id 由调用方给**（apps/server/auth/session.ts 的 `tokenId()`），所以这里没有自动生成主键 ——
 * 自动生成会把那个 HMAC 盖掉，cookie 就再也对不上库里的行。
 */
export const Session = defineEntity({
  name: 'Session',
  properties: {
    id: p.text().primary(),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /**
     * 这个会话是从哪个提供方登进来的。续期要按它挑 provider ——
     * GitHub 的 OAuth App token 不会过期也没有 refresh_token，走不了 Keycloak 那条路
     */
    provider: p.text().default('keycloak'),
    accessToken: p.text(),
    refreshToken: p.text().strictNullable(),
    idToken: p.text().strictNullable(),
    /** access_token 过期时间，到点用 refresh_token 续 */
    expiresAt: p.datetime(),
    refreshExpiresAt: p.datetime().strictNullable(),
    /** Keycloak 的 session_state，用于后端发起的单点登出 */
    sessionState: p.text().strictNullable(),
    userAgent: p.text().strictNullable(),
    ip: p.text().strictNullable(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  indexes: [{ properties: ['user'] }],
})
export type Session = InferEntity<typeof Session>

/**
 * 一条**等待用户确认**的账号关联（REQ-AUTH §3.9.3）。
 *
 * 第三方授权回来之后**不直接**写 `UserIdentity`，先落在这里，把「你要关联的是
 * @octocat」摆到用户眼前，点了确认才提交。
 *
 * 存在的理由是那个无感的处境：提供方那边可能正登着别人的账号（共用电脑最典型），
 * 而 OAuth App 一旦被授权过，之后连确认页都不会再弹 —— 点一下「关联」就直接跳回来了。
 * 所以「这到底绑的是谁」这句话必须由我们自己问一次，没有别人会问。
 */
export const PendingLink = defineEntity({
  name: 'PendingLink',
  properties: {
    id: idColumn(),
    /** 一个人同时只能有一条待确认的：再发起一次就把旧的顶掉（`user` 唯一） */
    user: () => p.manyToOne(User).unique().deleteRule('cascade'),
    provider: p.text(),
    subject: p.text(),
    issuer: p.text(),
    /** 确认页上显示的就是这几个 —— 用户要靠它们看清自己绑的是哪个账号 */
    username: p.text().strictNullable(),
    email: p.text().strictNullable(),
    avatarUrl: p.text().strictNullable(),
    createdAt: createdAtColumn(),
    expiresAt: p.datetime(),
  },
})
export type PendingLink = InferEntity<typeof PendingLink>

/**
 * 一次授权请求的临时凭据（state / nonce / PKCE code_verifier）。
 * 回调时一次性消费掉，防重放；过期的靠 sweep 清理。
 */
export const AuthRequest = defineEntity({
  name: 'AuthRequest',
  properties: {
    id: idColumn(),
    state: p.text().unique(),
    nonce: p.text(),
    codeVerifier: p.text(),
    /**
     * 这一趟走的是哪个提供方。回调只有一个（/api/auth/callback），
     * 靠这里分发 —— 所以加一个提供方不需要去对方后台再注册一个回调地址
     */
    provider: p.text().default('keycloak'),
    /**
     * 有值 = 这不是登录，是**已登录用户**在关联一条新的登录方式，
     * 回调时把身份绑到这个 user 上而不是建号 / 换人。只是一个 id，不建外键
     */
    linkUserId: p.text().strictNullable(),
    /** 登录成功后要跳回的前端地址（只允许站内路径） */
    redirectTo: p.text().default('/'),
    /**
     * 这一趟用的对外域名（`https://a.example.com`）。**必须存下来**：换 token 时带的
     * redirect_uri 要和授权那一步逐字符相同，回调这一趟重新算一遍是不保险的
     * （反代改了头、名单改了，都会算出另一个值，然后被提供方回绝）。
     * 取值只可能是 `APP_ORIGINS` 白名单里的某一个，见 `apps/server/auth/origin.ts`
     */
    origin: p.text().default(''),
    createdAt: createdAtColumn(),
    expiresAt: p.datetime(),
  },
})
export type AuthRequest = InferEntity<typeof AuthRequest>
