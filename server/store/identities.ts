import { prisma } from '../db.ts'
import { type ProviderId, type ProviderProfile, getProvider } from '../auth/providers/index.ts'
import type { User, UserIdentity } from '../generated/prisma/client.ts'

/**
 * 「登录方式」的数据层（REQ-AUTH §3.9）。
 *
 * 一个人可以绑多条 `UserIdentity`，其中一条是**主身份** —— 它就是 `User.issuer` /
 * `User.subject` 那一对值指向的那条。主身份没有单独的列，是比出来的：多存一个
 * `isPrimary` 布尔就多一个可能和 `User` 那两列对不上的地方。
 *
 * ## 身份只认 `(provider, subject)`，永远不认邮箱
 *
 * 「两条绑定的邮箱一样，所以是同一个人」这个推断**这里一条都不做**，哪怕提供方
 * 明说那个邮箱已验证。三个理由，按重要性：
 *
 * 1. **默认立场应该是「不同的人」**。合并只在有人**拿目标账号自己的凭据证明过自己**
 *    时发生 —— 也就是先登录进去，再从设置页点「关联」。那一步里的会话本身就是最强的
 *    证明，强过任何从邮箱推出来的结论，而且不需要信任任何第三方。
 * 2. **邮箱是属性不是标识**。它会变、注销后会被回收再分配（Google Workspace 的员工
 *    离职就是这样）、Sign in with Apple 还会逐应用发不同的私有转发地址。各家 IdP 的
 *    文档都写着「用 sub 不要用 email」，正是因为拿它当 key 迟早出事。
 * 3. **自动合号是账号接管的经典入口**。判定里「正在登录的这个人真的控制这个邮箱」
 *    这句话只能由来源 IdP 断言，我们无从复核；一旦某个 IdP 的验证不严（或管理员能
 *    直接把标志位置成 true），它就变成了一条登进别人账号的路。
 *
 * 代价是明确的、也是接受了的：同一个人先用 Keycloak、后用 GitHub 登录会得到**两个**
 * 账号。正确姿势是先用主账号登录再去关联 —— 别反过来。
 *
 * ## 三条规则，登录路径和设置页都靠它们：
 * - 每次登录都刷新**这条 identity** 的展示信息（用户名 / 邮箱 / 头像）和 `lastLoginAt`；
 * - `User` 上的档案字段（name / email / username / avatarUrl）**只有主身份登录时**才跟着变 ——
 *   否则「用 GitHub 登录一次」会把 Keycloak 那边的显示名悄悄换掉；
 * - `User.roles` **只有 Keycloak 登录时**才写，它是唯一的角色来源。用 GitHub 登进来
 *   拿到的是空数组，照写就等于每次都把人的角色清空。
 */

/** GitHub 那条路上 `User.issuer` 的固定值，回填时用它认出提供方 */
const GITHUB_ISSUER = 'https://github.com'

const iso = (value: Date | null) => value?.toISOString() ?? null

/** 设置页那张列表里的一行 */
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
  /** 主身份：档案字段跟着它走。解绑它会把另一条提升上来 */
  primary: boolean
}

/** 这条 identity 是不是当前的主身份 */
function isPrimary(row: Pick<UserIdentity, 'issuer' | 'subject'>, user: Pick<User, 'issuer' | 'subject'>) {
  return row.issuer === user.issuer && row.subject === user.subject
}

function toView(row: UserIdentity, user: Pick<User, 'issuer' | 'subject'>): IdentityView {
  const provider = row.provider as ProviderId
  return {
    id: row.id,
    provider,
    label: getProvider(provider)?.label ?? provider,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: iso(row.lastLoginAt),
    primary: isPrimary(row, user),
  }
}

/**
 * 落一条身份需要的全部字段。比 `ProviderProfile` 窄一圈 —— `name` / `roles`
 * 是给 `User` 档案用的，跟「这条绑定是谁」无关，所以关联那条路上不该被迫编造它们。
 */
export type LinkableIdentity = Pick<
  ProviderProfile,
  'subject' | 'issuer' | 'username' | 'email' | 'avatarUrl'
>

function identityData(provider: ProviderId, identity: LinkableIdentity) {
  return {
    provider,
    subject: identity.subject,
    issuer: identity.issuer,
    username: identity.username,
    email: identity.email,
    avatarUrl: identity.avatarUrl,
  }
}

/**
 * 存量用户的主身份回填。
 *
 * `UserIdentity` 是后加的表，在它之前登录过的人只有 `User.issuer` / `User.subject`
 * 那一对值。不写迁移脚本（这个仓库没有 migration，见 docs/05 §3.4），而是
 * **用到的时候补** —— 登录走 `resolveLogin` 的领养分支，设置页走 `listFor`。
 */
function backfillPrimary(user: User): Promise<UserIdentity> {
  const provider: ProviderId = user.issuer === GITHUB_ISSUER ? 'github' : 'keycloak'
  return prisma.userIdentity.create({
    data: {
      userId: user.id,
      provider,
      subject: user.subject,
      issuer: user.issuer,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      lastLoginAt: user.lastLoginAt,
    },
  })
}

export type LinkFailure =
  /** 这个第三方账号已经绑在**别人**身上了 */
  | 'taken'
  /** 这个第三方账号已经绑在**自己**身上了（重复点了一次） */
  | 'already-linked'
  /** 自己已经绑了这个提供方的**另一个**账号 */
  | 'provider-occupied'

export type LinkResult = { ok: true; identity: IdentityView } | { ok: false; reason: LinkFailure }

export type UnlinkResult = 'ok' | 'not-found' | 'last'

/** 待确认关联的存活时间：确认框就在眼前，不该给很长 */
export const PENDING_LINK_TTL = 10 * 60 * 1000

/**
 * 确认框上要显示的东西 —— 用户要靠它看清自己绑的是哪个账号。
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

export type ConfirmResult =
  | { ok: true; identity: IdentityView }
  /** `label` 是那条待确认关联的提供方显示名；`none` 时没有可说的，所以是可选的 */
  | { ok: false; reason: LinkFailure | 'expired' | 'none'; label?: string }

export const identities = {
  /**
   * 登录：把提供方给的身份换成本地用户。
   *
   * 三条分支，顺序不能反：
   * 1. 这条 identity 已经绑过 → 就是那个人；
   * 2. 没绑过，但 `User` 里有同 `(issuer, subject)` 的行 → **存量用户**，领养它并补上
   *    identity 行。少了这一步，老用户下次登录会被当成新人再建一个号；
   * 3. 都没有 → 新用户，User + identity 一次事务落库。
   *
   * **没有第四条「邮箱一样就算同一个人」**，哪怕提供方说那个邮箱已验证 —— 见文件头。
   */
  async resolveLogin(providerId: ProviderId, profile: ProviderProfile): Promise<User> {
    const now = new Date()

    const existing = await prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: providerId, subject: profile.subject } },
      include: { user: true },
    })

    if (existing) {
      const [, user] = await prisma.$transaction([
        prisma.userIdentity.update({
          where: { id: existing.id },
          data: {
            username: profile.username,
            email: profile.email,
            avatarUrl: profile.avatarUrl,
            lastLoginAt: now,
          },
        }),
        prisma.user.update({
          where: { id: existing.userId },
          data: {
            lastLoginAt: now,
            // 档案只跟主身份走；用副身份登录不改显示名 / 头像
            ...(isPrimary(existing, existing.user)
              ? {
                  username: profile.username,
                  email: profile.email,
                  name: profile.name,
                  ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
                }
              : {}),
            // 角色只有 Keycloak 给得出来，用 GitHub 登录时照写会把人的角色清空
            ...(providerId === 'keycloak' ? { roles: JSON.stringify(profile.roles) } : {}),
          },
        }),
      ])
      return user
    }

    // 存量用户：有 User 行但还没有 identity 行
    const legacy = await prisma.user.findUnique({
      where: { issuer_subject: { issuer: profile.issuer, subject: profile.subject } },
    })
    if (legacy) {
      const [, user] = await prisma.$transaction([
        prisma.userIdentity.create({
          data: { userId: legacy.id, ...identityData(providerId, profile), lastLoginAt: now },
        }),
        prisma.user.update({
          where: { id: legacy.id },
          data: {
            username: profile.username,
            email: profile.email,
            name: profile.name,
            ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
            ...(providerId === 'keycloak' ? { roles: JSON.stringify(profile.roles) } : {}),
            lastLoginAt: now,
          },
        }),
      ])
      return user
    }

    // 全新的人：这条 identity 就是主身份。
    // 邮箱撞上别人也照建不误 —— 这里**不做任何身份推断**
    return prisma.user.create({
      data: {
        issuer: profile.issuer,
        subject: profile.subject,
        username: profile.username,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        roles: JSON.stringify(providerId === 'keycloak' ? profile.roles : []),
        lastLoginAt: now,
        identities: { create: { ...identityData(providerId, profile), lastLoginAt: now } },
      },
    })
  },

  /**
   * 能不能绑？**只读**，不写任何东西。
   *
   * 回调那边拿它做一次预检：绑不成的情况（已经绑过、被别人占了）不该先让用户
   * 看一个注定失败的确认框。真正的判定仍然在 `link()` 里 —— 预检和确认之间隔着
   * 一段用户思考的时间，中间局面可能变，所以这只是体验，不是把关。
   */
  async checkLink(
    userId: string,
    providerId: ProviderId,
    subject: string,
  ): Promise<LinkFailure | null> {
    const owner = await prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: providerId, subject } },
    })
    if (owner) return owner.userId === userId ? 'already-linked' : 'taken'

    const mine = await prisma.userIdentity.findFirst({
      where: { userId, provider: providerId },
      select: { id: true },
    })
    if (mine) return 'provider-occupied'

    return null
  },

  /**
   * 关联：把一条新的登录方式绑到**已登录**的这个人身上。
   *
   * 三种拒绝理由要分开，因为给用户的话完全不同：绑在自己身上（白点了一次）、
   * 自己已经绑了这个提供方的另一个账号（先解绑）、绑在别人身上（去那边解绑）。
   */
  async link(
    userId: string,
    providerId: ProviderId,
    identity: LinkableIdentity,
  ): Promise<LinkResult> {
    const owner = await prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: providerId, subject: identity.subject } },
    })
    if (owner) {
      return { ok: false, reason: owner.userId === userId ? 'already-linked' : 'taken' }
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { identities: true },
    })
    // 会话里的 user 一定在库里（外键管着），读不到就是真出事了，别悄悄当成业务失败
    if (!user) throw new Error(`[identities] 会话里的用户不存在：${userId}`)

    // 存量用户还没回填过主身份就来关联第二条：**先**把第一条补上。
    // 顺序要紧：不补的话下面那条「一个提供方只留一条」看到的是一张空表，
    // 老用户重新关联同一个 Keycloak 会一路撞到唯一约束上，报出一句错话
    const rows = user.identities.length > 0 ? user.identities : [await backfillPrimary(user)]

    // 一个提供方只留一条：设置页那张列表按提供方读，两条 GitHub 并排时
    // 「解绑哪一个」和「主身份是哪个」都会变得需要解释
    if (rows.some((row) => row.provider === providerId)) {
      return { ok: false, reason: 'provider-occupied' }
    }

    try {
      const row = await prisma.userIdentity.create({
        data: { userId, ...identityData(providerId, identity) },
      })
      return { ok: true, identity: toView(row, user) }
    } catch {
      // 唯一约束撞车 = 这一瞬间被别人绑走了
      return { ok: false, reason: 'taken' }
    }
  },

  /** 设置页的列表。存量用户在这里被回填出主身份 */
  async listFor(userId: string): Promise<IdentityView[]> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { identities: true },
    })
    if (!user) return []

    const rows = user.identities.length > 0 ? user.identities : [await backfillPrimary(user)]
    return rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => toView(row, user))
  },

  /**
   * 解绑。**最后一条不许解** —— 解掉了这个人就再也登不进来，而这里没有
   * 「用邮箱找回」这种兜底，账号连同它名下的项目一起变成孤儿。
   *
   * 解掉的是主身份时，把剩下的第一条提升上来（改写 `User.issuer` / `subject`）。
   * 不改显示名和头像：换一种登录方式不该让别人看到的你变个样。
   *
   * 当前会话不受影响 —— 会话是我们自己发的，不是提供方发的。
   */
  async unlink(userId: string, identityId: string): Promise<UnlinkResult> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { identities: true },
    })
    if (!user) return 'not-found'

    const target = user.identities.find((row) => row.id === identityId)
    if (!target) return 'not-found'
    if (user.identities.length <= 1) return 'last'

    const promoted = isPrimary(target, user)
      ? user.identities.find((row) => row.id !== identityId)
      : null

    await prisma.$transaction([
      prisma.userIdentity.delete({ where: { id: identityId } }),
      ...(promoted
        ? [
            prisma.user.update({
              where: { id: userId },
              data: { issuer: promoted.issuer, subject: promoted.subject },
            }),
          ]
        : []),
    ])
    return 'ok'
  },

  // ------------------------------------------------------------ 待确认的关联

  /**
   * 第三方授权回来了，但**先别写**：把结果暂存下来等用户确认。
   *
   * 一个人同时只留一条（`userId` 唯一），再发起一次就顶掉旧的 —— 否则「确认框里
   * 显示的是哪一次的结果」会变成一个需要解释的问题。
   *
   * 这里**不存 access token**：确认时用不到它，而给一次还没被认可的绑定存凭证，
   * 是白白多担一份风险。
   */
  async stashPending(userId: string, providerId: ProviderId, profile: ProviderProfile) {
    const data = {
      provider: providerId,
      subject: profile.subject,
      issuer: profile.issuer,
      username: profile.username,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      expiresAt: new Date(Date.now() + PENDING_LINK_TTL),
    }
    await prisma.pendingLink.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })
  },

  /** 这个人有没有待确认的关联。过期的当作没有，并顺手删掉 */
  async pendingFor(userId: string): Promise<PendingLinkView | null> {
    const row = await prisma.pendingLink.findUnique({ where: { userId } })
    if (!row) return null
    if (row.expiresAt.getTime() < Date.now()) {
      await prisma.pendingLink.delete({ where: { userId } }).catch(() => undefined)
      return null
    }

    const provider = row.provider as ProviderId
    return {
      provider,
      label: getProvider(provider)?.label ?? provider,
      username: row.username,
      email: row.email,
      avatarUrl: row.avatarUrl,
    }
  },

  async discardPending(userId: string) {
    await prisma.pendingLink.delete({ where: { userId } }).catch(() => undefined)
  },

  /**
   * 用户点了确认：这时候才真的写。
   *
   * **重新判一遍能不能绑**（`link()` 自己会判）—— 预检和这一刻之间隔着用户思考的
   * 时间，那条身份完全可能已经被别人绑走了。
   *
   * 不论成败都把暂存删掉：失败了让用户重新走一遍，比留着一条注定失败的记录好。
   */
  async confirmPending(userId: string): Promise<ConfirmResult> {
    const row = await prisma.pendingLink.findUnique({ where: { userId } })
    if (!row) return { ok: false, reason: 'none' }

    const provider = row.provider as ProviderId
    const label = getProvider(provider)?.label ?? provider

    await prisma.pendingLink.delete({ where: { userId } }).catch(() => undefined)
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired', label }

    const result = await identities.link(userId, provider, {
      subject: row.subject,
      issuer: row.issuer,
      username: row.username,
      email: row.email,
      avatarUrl: row.avatarUrl,
    })
    return result.ok ? result : { ...result, label }
  },
}
