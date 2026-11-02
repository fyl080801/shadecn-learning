import { DataAccess, User } from '@learning/data-access'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'

export interface FindOrCreateUserInput {
  issuer: string
  subject: string
  username?: string | null
  email?: string | null
  name?: string | null
  avatarUrl?: string | null
  roles?: string[]
}

/**
 * 显示名的取值顺序，只此一份：协同在场信息和成员列表都从这里取，同一个人在两处才不会叫两个名字。
 * 要和前端 `useAuth().displayName` 一致，否则改写前后名字会跳。
 */
export function displayNameOf(user: { name: string | null; username: string | null; email: string | null }): string {
  return user.name ?? user.username ?? user.email ?? '匿名用户'
}

@Injectable()
export class UserService {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  findById(id: string): Promise<User | null> {
    return this.dataAccess.em().findOne(User, id)
  }

  /**
   * 按 `(issuer, subject)` 找或建，不认邮箱（`.claude/rules/auth.md`）。已存在的行一个字段都不改：登录时刷新档案不是这里的事。
   * 并发的两个调用同时建时，输的那个撞唯一约束后重查，只 catch 这一种错误。
   */
  async findOrCreate(input: FindOrCreateUserInput): Promise<User> {
    const where = { issuer: input.issuer, subject: input.subject }
    const existing = await this.dataAccess.em().findOne(User, where)
    if (existing) return existing

    try {
      const em = this.dataAccess.em()
      const user = em.create(User, {
        ...where,
        // em.create 不会补未设置的可空字段，要显式写 null（.claude/rules/database.md）
        username: input.username ?? null,
        email: input.email ?? null,
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        roles: JSON.stringify(input.roles ?? []),
        lastLoginAt: null,
      })
      await em.flush()
      return user
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) return this.dataAccess.em().findOneOrFail(User, where)
      throw err
    }
  }
}
