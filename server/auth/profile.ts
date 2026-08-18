import { prisma } from '../db.ts'
import type { User } from '../generated/prisma/client.ts'

/**
 * 用户档案的**补齐钩子**。
 *
 * 「登录之后再给这个人补点什么」是会不断长出来的一类需求（默认头像、默认显示名、
 * 默认时区……），但它们和登录本身没有关系。所以不往 `upsertUser` 里塞 ——
 * 那个函数只负责一件事：把 id_token 的 claims 落成本地 User。补齐是**挂在它外面**
 * 的一层：钩子只回答「这个人还缺什么」，合并成一次 update 由这里做。
 *
 * 加一条补齐规则 = 新增一个文件 + 一次 `registerProfileHook`，
 * 登录流程和已有的钩子都不用动。
 */

/** 钩子只能补档案类字段；roles / issuer / subject 这些身份字段不给碰 */
export type UserProfilePatch = Partial<Pick<User, 'name' | 'avatarUrl'>>

export interface UserProfileHook {
  /** 钩子名，去重和日志用 */
  name: string
  /** 缺就返回要补的字段，不缺返回 null */
  fill(user: User): UserProfilePatch | null | Promise<UserProfilePatch | null>
}

const hooks: UserProfileHook[] = []

/** 挂一条补齐规则；返回摘掉它的函数（测试和临时开关用得上） */
export function registerProfileHook(hook: UserProfileHook): () => void {
  // tsx watch 下模块可能被重新执行，同名的不重复挂
  if (!hooks.some((existing) => existing.name === hook.name)) hooks.push(hook)

  return () => {
    const at = hooks.findIndex((existing) => existing.name === hook.name)
    if (at >= 0) hooks.splice(at, 1)
  }
}

/** 当前挂了哪些钩子（测试用） */
export function profileHooks(): readonly UserProfileHook[] {
  return hooks
}

/**
 * 登录成功后跑一遍。
 *
 * **每次登录都跑**，所以存量用户下次进来就补上了 —— 不需要迁移脚本，
 * 也不需要在读取侧到处兜底。
 *
 * 钩子出错绝不能挡住登录：记一条日志，用户原样返回。
 */
export async function completeUserProfile(user: User): Promise<User> {
  let patch: UserProfilePatch = {}

  for (const hook of hooks) {
    try {
      const filled = await hook.fill(user)
      if (filled) patch = { ...patch, ...filled }
    } catch (err) {
      console.error(`[profile] 补齐钩子 ${hook.name} 出错，跳过`, err)
    }
  }

  if (Object.keys(patch).length === 0) return user

  try {
    return await prisma.user.update({ where: { id: user.id }, data: patch })
  } catch (err) {
    console.error('[profile] 写入补齐结果失败，本次登录先用原档案', err)
    return user
  }
}
