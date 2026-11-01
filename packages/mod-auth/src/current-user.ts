import type { Context } from 'hono'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { authEnabled } from './settings.ts'
import { db } from '@shadecn/server-kit/db'
import { User } from './entities.ts'
import { completeUserProfile } from './profile.ts'
import type { SessionUser } from './session.ts'

/**
 * 「这个请求是谁」—— 平台能力 `auth.userId` 的实现（`../platform.ts`），模块经 `ctx.platform.auth.userId(c)` 问到这里。
 */

const DEV_USER = {
  issuer: 'dev://local',
  subject: 'dev-user',
  username: 'dev',
  name: '本地开发用户',
} as const

/**
 * 没配 Keycloak 时（authEnabled === false）也得有个用户，
 * 否则项目功能在本地裸跑起不来。落一个固定的开发用户，仅限非生产。
 */
async function devUserId(): Promise<string> {
  const user = await findOrCreateDevUser()
  // 本地模式也走一遍档案补齐，头像这类东西不该只有连了 Keycloak 才有
  return (await completeUserProfile(user)).id
}

/**
 * 有就取，没有就建。并发的两个请求同时建时，输的那个撞 (issuer, subject) 唯一约束，重查一次即可 ——
 * 和 Prisma 时代 `upsert({ update: {} })` 的效果一样：已存在的那行一个字段都不改。
 */
async function findOrCreateDevUser(): Promise<User> {
  const where = { issuer: DEV_USER.issuer, subject: DEV_USER.subject }
  const existing = await db().findOne(User, where)
  if (existing) return existing

  try {
    const em = db()
    const user = em.create(User, { ...DEV_USER, email: null, roles: '[]' })
    await em.flush()
    return user
  } catch (err) {
    if (err instanceof UniqueConstraintViolationException) return db().findOneOrFail(User, where)
    throw err
  }
}

/** 取当前请求者的 user id；未登录返回 null */
export async function currentUserId(c: Context): Promise<string | null> {
  const user = c.get('user') as SessionUser | null
  if (user) return user.id
  if (!authEnabled) return devUserId()
  return null
}

