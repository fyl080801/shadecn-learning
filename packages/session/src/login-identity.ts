import { User } from '@learning/data-access'
import type { EntityManager } from '@mikro-orm/core'
import { UserIdentity } from './entities.js'
import type { ProviderProfile } from './oauth/index.js'

/**
 * 登录时「提供方给的身份 → 本地用户」的那一段。EntityManager 由调用方给，不碰配置和全局状态。
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
 * ## 规则
 * - 每次登录都刷新**这条 identity** 的展示信息（用户名 / 邮箱 / 头像）和 `lastLoginAt`；
 * - `User` 上的档案字段（name / email / username / avatarUrl）**只有主身份登录时**才跟着变 ——
 *   否则「用 GitHub 登录一次」会把 Keycloak 那边的显示名悄悄换掉；
 * - `User.roles` **只有拥有角色的提供方登录时**才写，它是唯一的角色来源。用 GitHub 登进来
 *   拿到的是空数组，照写就等于每次都把人的角色清空。
 */

/** 这条 identity 是不是当前的主身份 */
export function isPrimary(row: Pick<UserIdentity, 'issuer' | 'subject'>, user: Pick<User, 'issuer' | 'subject'>) {
  return row.issuer === user.issuer && row.subject === user.subject
}

/**
 * 落一条身份需要的全部字段。比 `ProviderProfile` 窄一圈 —— `name` / `roles`
 * 是给 `User` 档案用的，跟「这条绑定是谁」无关，所以关联那条路上不该被迫编造它们。
 */
export type LinkableIdentity = Pick<ProviderProfile, 'subject' | 'issuer' | 'username' | 'email' | 'avatarUrl'>

export function identityData(provider: string, identity: LinkableIdentity) {
  return {
    provider,
    subject: identity.subject,
    issuer: identity.issuer,
    username: identity.username,
    email: identity.email,
    avatarUrl: identity.avatarUrl,
  }
}

export interface ResolveLoginInput {
  /** 提供方 id，`UserIdentity.provider` 的取值 */
  provider: string
  profile: ProviderProfile
  /** 这个提供方是不是角色的来源：只有它登录时才写 `User.roles` */
  ownsRoles: boolean
}

/**
 * 登录：把提供方给的身份换成本地用户。`em` 每次调用都要给一个新的 fork。
 *
 * 三条分支，顺序不能反：
 * 1. 这条 identity 已经绑过 → 就是那个人；
 * 2. 没绑过，但 `User` 里有同 `(issuer, subject)` 的行 → **存量用户**，领养它并补上
 *    identity 行。少了这一步，老用户下次登录会被当成新人再建一个号；
 * 3. 都没有 → 新用户，User + identity 一次事务落库。
 *
 * **没有第四条「邮箱一样就算同一个人」**，哪怕提供方说那个邮箱已验证 —— 见文件头。
 */
export async function resolveLoginIdentity(em: () => EntityManager, input: ResolveLoginInput): Promise<User> {
  const { provider, profile, ownsRoles } = input
  const now = new Date()

  const existing = await em().findOne(UserIdentity, { provider, subject: profile.subject }, { populate: ['user'] })

  if (existing) {
    return em().transactional(async (tx) => {
      await tx.nativeUpdate(
        UserIdentity,
        { id: existing.id },
        {
          username: profile.username,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
          lastLoginAt: now,
        },
      )
      await tx.nativeUpdate(
        User,
        { id: existing.user.id },
        {
          lastLoginAt: now,
          updatedAt: now,
          // 档案只跟主身份走；用副身份登录不改显示名 / 头像
          ...(isPrimary(existing, existing.user)
            ? {
                username: profile.username,
                email: profile.email,
                name: profile.name,
                ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
              }
            : {}),
          // 用不拥有角色的提供方登录时照写会把人的角色清空
          ...(ownsRoles ? { roles: JSON.stringify(profile.roles) } : {}),
        },
      )
      return tx.findOneOrFail(User, existing.user.id)
    })
  }

  // 存量用户：有 User 行但还没有 identity 行
  const legacy = await em().findOne(User, { issuer: profile.issuer, subject: profile.subject })
  if (legacy) {
    return em().transactional(async (tx) => {
      tx.create(UserIdentity, {
        user: legacy.id,
        ...identityData(provider, profile),
        lastLoginAt: now,
      })
      await tx.flush()
      await tx.nativeUpdate(
        User,
        { id: legacy.id },
        {
          username: profile.username,
          email: profile.email,
          name: profile.name,
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          ...(ownsRoles ? { roles: JSON.stringify(profile.roles) } : {}),
          lastLoginAt: now,
          updatedAt: now,
        },
      )
      return tx.findOneOrFail(User, legacy.id, { refresh: true })
    })
  }

  // 全新的人：这条 identity 就是主身份，和 User 一个事务落库。
  // 邮箱撞上别人也照建不误 —— 这里**不做任何身份推断**
  return em().transactional(async (tx) => {
    const user = tx.create(User, {
      issuer: profile.issuer,
      subject: profile.subject,
      username: profile.username,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      roles: JSON.stringify(ownsRoles ? profile.roles : []),
      lastLoginAt: now,
    })
    tx.create(UserIdentity, { user, ...identityData(provider, profile), lastLoginAt: now })
    return user
  })
}
