import { db } from '../db.ts'
import { User } from '../db/entities/index.ts'

/**
 * 用户的只读查询 —— 目前只有「显示名」。
 *
 * 名字的取值顺序只此一份：协同层在场信息的名字（`auth/ws.ts`）和画布 Agent 的「谁在跑」
 * （`activeRun.initiator.name`）都从这里取，同一个人在两处才不会叫两个名字。
 */

/** 显示名的取值顺序要和前端 `useAuth().displayName` 一致，否则改写前后名字会跳 */
export function displayNameOf(user: {
  name: string | null
  username: string | null
  email: string | null
}): string {
  return user.name ?? user.username ?? user.email ?? '匿名用户'
}

export const users = {
  /** 查不到这个人（已被删）时同样落到兜底的那个名字 */
  async displayName(userId: string): Promise<string> {
    const row = await db().findOne(User, userId, { fields: ['name', 'username', 'email'] })
    return displayNameOf(row ?? { name: null, username: null, email: null })
  },
}
