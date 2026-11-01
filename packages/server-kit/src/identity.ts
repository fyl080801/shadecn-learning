import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { createdAtColumn, db, idColumn, updatedAtColumn } from './db.ts'

/**
 * 平台的「人」（docs/28 §3.1.1）：`User` 表和「给别人看的那份」用户信息。
 *
 * 登录、会话、身份绑定是登录模块的事（`packages/mod-auth/src/`），但**用户这张表是所有模块的公共外键目标** ——
 * 画布的创建人、项目成员、agent 的会话都指向它。模块包之间不该为了一个外键互相依赖，所以实体定义放在平台库里，
 * 底座和所有模块引用的是同一个实体对象。
 */

/**
 * 用户档案。档案字段来自**主身份**那个提供方（Keycloak 的 id_token / GitHub 的 /user）。
 *
 * `(issuer, subject)` 仍然是唯一键，但它的含义是**主身份的冗余副本** ——
 * 真正的绑定清单在 `UserIdentity` 里（登录模块），一个人可以绑多条。留着这两列有两个理由：
 * 默认头像的种子是按 (issuer, subject) 算的（换主身份不该换掉那张图）、无 Keycloak 的本地开发用户还靠它找回自己。
 * 解绑主身份时会把另一条身份提升上来，一并改写这两列（见 packages/mod-auth/src/identities.ts）。
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
 * 显示名的取值顺序 —— 只此一份：协同在场信息的名字和 agent 的会话 / 任务发起人都从这里取，同一个人在两处才不会叫两个名字。
 * 要和前端 `useAuth().displayName` 一致，否则改写前后名字会跳。
 */
export function displayNameOf(user: { name: string | null; username: string | null; email: string | null }): string {
  return user.name ?? user.username ?? user.email ?? '匿名用户'
}

/** 给别人看的用户信息。**没有邮箱字段**：名字兜底时可能落到邮箱（同在场信息、成员列表的口径），但不单独给出 */
export interface UserBrief {
  id: string
  name: string
  avatarUrl: string | null
}

export const users = {
  /**
   * 一批人的显示名 + 头像，一次查询。查不到的（已被删）也给一份兜底（同一个兜底名字），
   * 所以每个请求的 id 都在结果里
   */
  async briefs(userIds: readonly string[]): Promise<Map<string, UserBrief>> {
    const ids = [...new Set(userIds)]
    const result = new Map<string, UserBrief>()
    if (ids.length === 0) return result
    const rows = await db().find(User, { id: { $in: ids } }, { fields: ['id', 'name', 'username', 'email', 'avatarUrl'] })
    for (const row of rows) result.set(row.id, { id: row.id, name: displayNameOf(row), avatarUrl: row.avatarUrl })
    for (const id of ids) {
      if (!result.has(id)) result.set(id, { id, name: displayNameOf({ name: null, username: null, email: null }), avatarUrl: null })
    }
    return result
  },
}
