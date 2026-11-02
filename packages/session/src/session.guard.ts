import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { type SessionUser, toSessionUser } from './session-token.js'
import { SessionService } from './session.service.js'

/** 守卫要读写的那部分请求对象。不依赖 Fastify 的类型，`headers.cookie` 是 Node 的原始请求头 */
export interface SessionRequest {
  headers: Record<string, unknown>
  /** 只有 `SessionUser`：会话实体带 access_token 等列，绝不挂到请求上 */
  user?: SessionUser
}

/**
 * 从 Cookie 请求头里取一个值。多个同名时取第一个（浏览器把路径最具体的放在前面）。
 * 只找一个名字，不解析成对象：`__proto__=x` 这样的 cookie 名没有机会碰到原型。
 * 百分号编码不合法时返回原文：它只是一个对不上任何会话的 token，不该变成 500。
 */
export function readCookie(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

/** 前端按状态码判断（`apiFetch`），`error` 是 `api.ts` 读的字段，和 `apps/server` 的 401 同形 */
function unauthorized() {
  return new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: '需要登录' })
}

/**
 * `@UseGuards(SessionGuard)`：会话无效 → 401；有效 → 把 `SessionUser` 挂到请求上，路由用 `@CurrentUser()` 取。
 * 查库失败照常抛（500），不能把数据库故障说成未登录。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>()
    const session = await this.sessions.load(readCookie(request.headers.cookie, this.sessions.cookieName))
    if (!session) throw unauthorized()
    request.user = toSessionUser(session.user)
    return true
  }
}
