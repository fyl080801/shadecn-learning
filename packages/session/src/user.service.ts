import { DataAccess, UniqueConstraintViolationException, User } from '@learning/data-access'
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

@Injectable()
export class UserService {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  findById(id: string): Promise<User | null> {
    return this.dataAccess.em().findOne(User, id)
  }

  /**
   * 身份只认 `(issuer, subject)`，不认邮箱（`.claude/rules/auth.md`）。已存在的行一个字段都不改：登录时刷新档案不是这里的事。
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
