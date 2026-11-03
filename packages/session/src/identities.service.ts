import type { IdentityView, PendingLinkView } from '@learning/contracts/auth'
import { DataAccess, newId, User } from '@learning/data-access'
import { type EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'
import { AuthProviders } from './auth-providers.js'
import { PendingLink, UserIdentity } from './entities.js'
import { identityData, isPrimary, type LinkableIdentity } from './login-identity.js'
import { GITHUB_ISSUER, type ProviderProfile } from './oauth/index.js'

/**
 * 「登录方式」的数据层（docs/02 §3.9）。
 *
 * 一个人可以绑多条 `UserIdentity`，其中一条是**主身份**：它就是 `User.issuer` / `User.subject` 那一对值指向的那条，没有单独的列，是比出来的。
 * 身份只认 `(provider, subject)`，这里没有任何一处看邮箱（理由在 `login-identity.ts` 文件头）。
 */

/** `provider` 的取值这里是 `oidc` / `github`，`@learning/contracts` 那份类型写的是前端的 `keycloak` / `github`：前端认不出的提供方用默认图标，不影响功能 */
export type IdentityRowView = Omit<IdentityView, 'provider'> & { provider: string }
export type PendingLinkRowView = Omit<PendingLinkView, 'provider'> & { provider: string }

export type LinkFailure =
  /** 这个第三方账号已经绑在**别人**身上了 */
  | 'taken'
  /** 这个第三方账号已经绑在**自己**身上了（重复点了一次） */
  | 'already-linked'
  /** 自己已经绑了这个提供方的**另一个**账号 */
  | 'provider-occupied'

export type LinkResult = { ok: true; identity: IdentityRowView } | { ok: false; reason: LinkFailure }

export type UnlinkResult = 'ok' | 'not-found' | 'last'

export type ConfirmResult =
  | { ok: true; identity: IdentityRowView }
  /** `label` 是那条待确认关联的提供方显示名；`none` 时没有可说的 */
  | { ok: false; reason: LinkFailure | 'expired' | 'none'; label?: string }

/** 待确认关联的存活时间：确认框就在眼前，不该给很长 */
export const PENDING_LINK_TTL_MS = 10 * 60 * 1000

/** 关联失败时给用户的话。三种理由要分开说，因为该做的事完全不同 */
export function linkFailureMessage(reason: LinkFailure, label: string): string {
  return {
    'already-linked': `这个 ${label} 账号已经关联过了`,
    'provider-occupied': `你已经关联了另一个 ${label} 账号，请先解绑它`,
    taken: `这个 ${label} 账号已经关联到另一个用户，请先用它登录并解绑`,
  }[reason]
}

const identitiesOf = (em: EntityManager, userId: string) => em.find(UserIdentity, { user: userId }, { orderBy: { createdAt: 'asc', id: 'asc' } })

/**
 * 进事务后先锁用户行，同一个人的关联、解绑、回填排队跑。否则两个标签页同时解绑仅有的两条，都看到「还剩两条」，一起删完就再也登不进来。
 * PostgreSQL 是 `select … for update`；SQLite 上事务本来就独占连接，MikroORM 不加这个子句。
 */
const lockUser = (tx: EntityManager, userId: string) => tx.findOne(User, userId, { lockMode: LockMode.PESSIMISTIC_WRITE })

/** 还没有 identity 行的用户（直接建的 `User`）用到时补出主身份。调用方要持有 {@link lockUser} */
async function rowsWithPrimary(tx: EntityManager, user: User): Promise<UserIdentity[]> {
  const rows = await identitiesOf(tx, user.id)
  if (rows.length > 0) return rows
  const row = tx.create(UserIdentity, {
    user: user.id,
    provider: user.issuer === GITHUB_ISSUER ? 'github' : 'oidc',
    subject: user.subject,
    issuer: user.issuer,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
    lastLoginAt: user.lastLoginAt,
  })
  await tx.flush()
  return [row]
}

@Injectable()
export class IdentitiesService {
  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(AuthProviders) private readonly providers: AuthProviders,
  ) {}

  private labelOf(provider: string): string {
    return this.providers.get(provider)?.label ?? provider
  }

  private toView(row: UserIdentity, user: Pick<User, 'issuer' | 'subject'>): IdentityRowView {
    return {
      id: row.id,
      provider: row.provider,
      label: this.labelOf(row.provider),
      username: row.username,
      email: row.email,
      avatarUrl: row.avatarUrl,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      primary: isPrimary(row, user),
    }
  }

  /**
   * 能不能绑？**只读。** 回调拿它做一次预检：绑不成的情况不该先让用户看一个注定失败的确认框。
   * 真正的判定在 {@link link}：预检和确认之间隔着用户思考的时间，局面可能变，所以这只是体验，不是把关。
   */
  async checkLink(userId: string, provider: string, subject: string): Promise<LinkFailure | null> {
    const em = this.dataAccess.em()
    const owner = await em.findOne(UserIdentity, { provider, subject })
    if (owner) return owner.user.id === userId ? 'already-linked' : 'taken'
    return (await em.count(UserIdentity, { user: userId, provider })) > 0 ? 'provider-occupied' : null
  }

  /**
   * 把一条新的登录方式绑到这个人身上。只有确认那一步调它。
   * 一个提供方只留一条：两条 GitHub 并排时「解绑哪一个」和「主身份是哪个」都要解释。
   */
  private async link(userId: string, provider: string, identity: LinkableIdentity): Promise<LinkResult> {
    try {
      return await this.dataAccess.transactional(async (tx): Promise<LinkResult> => {
        const user = await lockUser(tx, userId)
        // 会话里的 user 一定在库里（外键管着），读不到就是真出事了，别悄悄当成业务失败
        if (!user) throw new Error(`[session] 会话里的用户不存在：${userId}`)

        const owner = await tx.findOne(UserIdentity, { provider, subject: identity.subject })
        if (owner) return { ok: false, reason: owner.user.id === userId ? 'already-linked' : 'taken' }

        // 先补主身份再判「一个提供方只留一条」：不补的话下面看到的是空表，重新关联同一个提供方会一路撞到唯一约束上
        const rows = await rowsWithPrimary(tx, user)
        if (rows.some((row) => row.provider === provider)) return { ok: false, reason: 'provider-occupied' }

        const row = tx.create(UserIdentity, { user: userId, ...identityData(provider, identity), lastLoginAt: null })
        await tx.flush()
        return { ok: true, identity: this.toView(row, user) }
      })
    } catch (err) {
      // 唯一约束撞车 = 这一瞬间被别人绑走了。别的错误照常抛
      if (err instanceof UniqueConstraintViolationException) return { ok: false, reason: 'taken' }
      throw err
    }
  }

  /** 设置页的列表，按绑定先后排。没有 identity 行的用户在这里补出主身份 */
  async listFor(userId: string): Promise<IdentityRowView[]> {
    const em = this.dataAccess.em()
    const user = await em.findOne(User, userId)
    if (!user) return []
    const rows = await identitiesOf(em, userId)
    if (rows.length > 0) return rows.map((row) => this.toView(row, user))
    return this.dataAccess.transactional(async (tx) => {
      const locked = await lockUser(tx, userId)
      if (!locked) return []
      return (await rowsWithPrimary(tx, locked)).map((row) => this.toView(row, locked))
    })
  }

  /**
   * 解绑。**最后一条不许解**：解掉了这个人就再也登不进来，这里没有「用邮箱找回」，账号连同名下的项目一起变成孤儿。
   * 解掉的是主身份时，把剩下的第一条提升上来（改写 `User.issuer` / `subject`）。**不改显示名和头像**：换一种登录方式不该让别人看到的你变个样。
   * 当前会话不受影响：会话是这里发的，不是提供方发的。
   */
  unlink(userId: string, identityId: string): Promise<UnlinkResult> {
    return this.dataAccess.transactional(async (tx): Promise<UnlinkResult> => {
      const user = await lockUser(tx, userId)
      if (!user) return 'not-found'

      const rows = await identitiesOf(tx, userId)
      const target = rows.find((row) => row.id === identityId)
      if (!target) return 'not-found'
      if (rows.length <= 1) return 'last'

      const promoted = isPrimary(target, user) ? rows.find((row) => row.id !== identityId) : undefined
      await tx.nativeDelete(UserIdentity, { id: identityId })
      if (promoted) await tx.nativeUpdate(User, { id: userId }, { issuer: promoted.issuer, subject: promoted.subject, updatedAt: new Date() })
      return 'ok'
    })
  }

  /**
   * 第三方授权回来了，但**先别写绑定**：暂存下来等用户确认。提供方那边可能正登着别人的账号，授权过一次之后连确认页都不弹，「绑的到底是谁」只能由我们问。
   * 一个人同时只留一条（`user` 唯一），再发起一次就顶掉旧的。**不存 access token**：确认时用不到，给还没被认可的绑定存凭证是白担风险。
   */
  async stashPending(userId: string, provider: string, profile: ProviderProfile): Promise<void> {
    const data = {
      provider,
      subject: profile.subject,
      issuer: profile.issuer,
      username: profile.username,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      expiresAt: new Date(Date.now() + PENDING_LINK_TTL_MS),
    }
    // upsert 直接发 SQL：id / createdAt 不会自动生成，得自己给；撞上同一个人的旧暂存时整条换掉（id 不变）
    await this.dataAccess.em().upsert(
      PendingLink,
      { id: newId(), user: userId, createdAt: new Date(), ...data },
      { onConflictFields: ['user'], onConflictMergeFields: ['provider', 'subject', 'issuer', 'username', 'email', 'avatarUrl', 'createdAt', 'expiresAt'] },
    )
  }

  /** 这个人有没有待确认的关联。过期的当作没有，并顺手删掉 */
  async pendingFor(userId: string): Promise<PendingLinkRowView | null> {
    const em = this.dataAccess.em()
    const row = await em.findOne(PendingLink, { user: userId })
    if (!row) return null
    if (row.expiresAt.getTime() < Date.now()) {
      await em.nativeDelete(PendingLink, { user: userId })
      return null
    }
    return { provider: row.provider, label: this.labelOf(row.provider), username: row.username, email: row.email, avatarUrl: row.avatarUrl }
  }

  async discardPending(userId: string): Promise<void> {
    await this.dataAccess.em().nativeDelete(PendingLink, { user: userId })
  }

  /**
   * 用户点了确认：这时候才真的写，并**重新判一遍能不能绑**（{@link link}），那条身份可能已经被别人绑走了。
   * 不论成败都把暂存删掉：失败了让用户重新走一遍，比留着一条注定失败的记录好。
   * 消费以删除成功为准：同一条待确认被同时确认两次，只有真删掉那一行的算数。
   */
  async confirmPending(userId: string): Promise<ConfirmResult> {
    const em = this.dataAccess.em()
    const row = await em.findOne(PendingLink, { user: userId })
    if (!row) return { ok: false, reason: 'none' }
    if ((await em.nativeDelete(PendingLink, { id: row.id })) === 0) return { ok: false, reason: 'none' }

    const label = this.labelOf(row.provider)
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired', label }

    const result = await this.link(userId, row.provider, {
      subject: row.subject,
      issuer: row.issuer,
      username: row.username,
      email: row.email,
      avatarUrl: row.avatarUrl,
    })
    return result.ok ? result : { ...result, label }
  }
}
