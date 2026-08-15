import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { authConfig, authEnabled } from '../config.ts'
import { type LoadedSession, type SessionUser, loadSession, toSessionUser } from './session.ts'

/** 挂在 Hono context 上的登录态，路由里用 c.get('user') 取 */
export type AuthVariables = {
  session: LoadedSession | null
  user: SessionUser | null
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, authConfig.cookieName, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: authConfig.secureCookie,
    path: '/',
    maxAge: authConfig.ttl,
  })
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, authConfig.cookieName, {
    path: '/',
    secure: authConfig.secureCookie,
  })
}

export function readSessionCookie(c: Context) {
  return getCookie(c, authConfig.cookieName)
}

/**
 * 解析会话（不拦截）。放在所有 /api 路由前面，
 * 需要登录的地方再叠一层 requireAuth。
 */
export const withSession: MiddlewareHandler = async (c, next) => {
  const token = readSessionCookie(c)
  const session = authEnabled ? await loadSession(token) : null

  // cookie 还在但会话已经没了（过期/被登出）——顺手把 cookie 清掉
  if (token && !session) clearSessionCookie(c)

  c.set('session', session)
  c.set('user', session ? toSessionUser(session.user) : null)
  await next()
}

/** 未登录直接 401，前端拿到 401 会跳登录页 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!authEnabled) return next()
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)
  }
  await next()
}

/** 要求带某个角色，用法：app.use('/api/admin/*', requireRole('admin')) */
export function requireRole(...roles: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!authEnabled) return next()
    const user = c.get('user') as SessionUser | null
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)
    if (!roles.some((role) => user.roles.includes(role))) {
      return c.json({ error: 'Forbidden', message: `需要角色：${roles.join(' / ')}` }, 403)
    }
    await next()
  }
}
