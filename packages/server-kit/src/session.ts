import { createHmac, randomBytes } from 'node:crypto'

/**
 * 会话的纯函数：不碰实体对象、不碰全局状态，密钥由调用方给。
 * `@shadecn/mod-auth` 和 `@learning/session` 共用这一份 —— 算法两边必须一致，否则同一个 token 在两边对应不同的行。
 */

/** cookie 里放的原始 token：32 字节随机数 */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 库里存的会话 id：token 的 HMAC-SHA256。拖库的人拿不到 token 本身，也就伪造不出 cookie。
 * **改算法 = 所有现存会话失效**，`apps/server/test/auth/session.test.ts` 和 `test/session.test.ts` 用写死的摘要钉着。
 */
export function sessionTokenId(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex')
}

/** 给前端 / 业务代码看的用户信息 —— access_token 一类的东西一律不在这里 */
export interface SessionUser {
  id: string
  subject: string
  username: string | null
  email: string | null
  name: string | null
  avatarUrl: string | null
  roles: string[]
}

/** 参数用结构类型：这个文件不 import `User` 实体，内联它的包不会因此多一份实体定义 */
export function toSessionUser(user: {
  id: string
  subject: string
  username: string | null
  email: string | null
  name: string | null
  avatarUrl: string | null
  /** JSON 字符串；坏数据按没有角色处理 */
  roles: string
}): SessionUser {
  let roles: string[] = []
  try {
    const parsed: unknown = JSON.parse(user.roles)
    if (Array.isArray(parsed)) roles = parsed.filter((r): r is string => typeof r === 'string')
  } catch {
    roles = []
  }
  return {
    id: user.id,
    subject: user.subject,
    username: user.username,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    roles,
  }
}
