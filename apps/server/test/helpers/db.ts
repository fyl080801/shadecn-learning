import type { EntityName } from '@mikro-orm/core'
import { db, orm } from '../../db.ts'
import {
  AgentConversation,
  AgentGrant,
  AgentGrantScope,
  AgentRun,
  AgentToolCall,
  AuthRequest,
  Flow,
  FlowUserState,
  PendingLink,
  Project,
  ProjectInvite,
  ProjectMember,
  Session,
  User,
  UserIdentity,
} from '../../db/entities/index.ts'

export { db, orm }

/**
 * 每个用例前清库。都有外键，先删子表。
 *
 * 级联（User 一删，身份 / 会话 / 待确认关联跟着没）其实也能清干净，这里仍然逐表删：
 * 不依赖级联，清库这一步就不会因为哪天某条外键改了删除规则而悄悄漏删。
 */
export async function resetDb() {
  const em = db()
  // 实体各自的类型推断不能互相赋值，作为「一张表」这里只关心名字
  const tables = [
    AgentGrantScope,
    AgentGrant,
    AgentToolCall,
    AgentRun,
    AgentConversation,
    FlowUserState,
    Flow,
    ProjectInvite,
    ProjectMember,
    Project,
    PendingLink,
    UserIdentity,
    Session,
    AuthRequest,
    User,
  ] as unknown as EntityName<object>[]
  for (const entity of tables) await em.nativeDelete(entity, {})
}

export interface FakeUserInput {
  subject?: string
  issuer?: string
  username?: string | null
  email?: string | null
  name?: string | null
  roles?: string[]
}

/** 直接往库里塞一个用户，绕开 OIDC 流程（不建 UserIdentity —— 正是「存量用户」的形状） */
export async function createUser(input: FakeUserInput = {}): Promise<User> {
  const em = db()
  const user = em.create(User, {
    issuer: input.issuer ?? 'https://keycloak.test/realms/test',
    subject: input.subject ?? 'user-1',
    username: input.username ?? 'alice',
    email: input.email ?? 'alice@example.com',
    name: input.name ?? 'Alice',
    avatarUrl: null,
    roles: JSON.stringify(input.roles ?? []),
    lastLoginAt: null,
  })
  await em.flush()
  return user
}

/**
 * 表里的第一行，没有就抛 —— Prisma 时代 `findFirstOrThrow()` 的替身。
 * MikroORM 的 `findOneOrFail` 不接受空条件（会直接报错），所以单独给一个。
 */
export async function firstRow<T extends object>(entity: EntityName<T>): Promise<T> {
  const [row] = await db().find(entity, {}, { limit: 1 })
  if (!row) throw new Error('[test] 表里一行都没有')
  return row as T
}
