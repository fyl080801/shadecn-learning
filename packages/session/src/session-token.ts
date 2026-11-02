import { createHmac, randomBytes } from 'node:crypto'

/**
 * 会话的纯函数：不碰实体对象、不碰全局状态，密钥由调用方给。
 */

/** cookie 里放的原始 token：32 字节随机数 */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 库里存的会话 id：token 的 HMAC-SHA256。拖库的人拿不到 token 本身，也就伪造不出 cookie。
 * **改算法 = 所有现存会话失效**，`test/session-token.test.ts` 用写死的摘要钉着。
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

/** 只挑白名单字段，参数用结构类型：多带的 token 列不会漏出去 */
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
