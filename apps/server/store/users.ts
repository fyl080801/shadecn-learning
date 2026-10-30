import { db } from '../db.ts'
import { User } from '../db/entities/index.ts'

/**
 * 用户的只读查询 —— 目前只有「给别人看的那份」：显示名 + 头像。
 *
 * 名字的取值顺序只此一份：协同层在场信息的名字（`auth/ws.ts`）和画布 Agent 的会话 / 任务发起人
 * （`owner.name`）都从这里取，同一个人在两处才不会叫两个名字。
 */

/** 显示名的取值顺序要和前端 `useAuth().displayName` 一致，否则改写前后名字会跳 */
export function displayNameOf(user: {
  name: string | null
  username: string | null
  email: string | null
}): string {
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
  async briefs(userIds: string[]): Promise<Map<string, UserBrief>> {
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
