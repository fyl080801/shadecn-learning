import type { MiddlewareHandler } from 'hono'
import type { ServerApp, ServerEnv } from '../app.ts'
import { safeRedirect } from '../auth/redirect.ts'
import { authEnabled, isApiPath } from '../config.ts'
import { renderLoginPage } from './login-page.ts'

/** 登录页由服务端渲染，不是 SPA 路由 */
export const LOGIN_PATH = '/login'

/**
 * 匿名浏览器唯一能取到的非 /api 路径：登录页本身和它引用的图标。
 * 其余（index.html、/assets/*，dev 下的 /src/**、/@vite/*）都属于前端，
 * 一律挡在会话校验后面。
 */
const PUBLIC_PAGES = new Set([LOGIN_PATH, '/favicon.ico', '/vite.svg'])

/** 是不是整页导航 —— 只有它才适合用重定向回应 */
function isNavigation(headers: Headers, method: string) {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (headers.get('sec-fetch-mode') === 'navigate') return true
  return (headers.get('accept') ?? '').includes('text/html')
}

function pathWithQuery(url: string) {
  const { pathname, search } = new URL(url)
  return `${pathname}${search}`
}

export function loginPathFor(target: string) {
  return `${LOGIN_PATH}?redirect=${encodeURIComponent(safeRedirect(target))}`
}

/**
 * 页面侧的闸门。挂在 /api 路由之后（那边有自己的闸门，未登录回 JSON 401）、
 * 前端中间件之前，所以匿名访问者拿不到 SPA 的任何一个字节。
 */
export const pageGuard: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (isApiPath(c.req.path)) return next()
  if (!authEnabled) return next()
  if (PUBLIC_PAGES.has(c.req.path)) return next()
  if (c.get('user')) return next()

  // 整页导航送去登录页；资源和 XHR 直接 401 ——
  // 给一个 .js 请求回 HTML 只会让浏览器报解析错误
  if (isNavigation(c.req.raw.headers, c.req.method)) {
    return c.redirect(loginPathFor(pathWithQuery(c.req.url)), 302)
  }
  return c.text('Unauthorized', 401)
}

/** 挂登录页 + 页面闸门。要在 /api 路由挂完之后调用 */
export function attachPageGuard(app: ServerApp) {
  app.get(LOGIN_PATH, (c) => {
    const redirect = safeRedirect(c.req.query('redirect'))

    // 已经登录了就别停在登录页
    if (authEnabled && c.get('user')) return c.redirect(redirect, 302)

    const error = c.req.query('error')
    return c.html(renderLoginPage({ redirect, error }), 200, {
      'cache-control': 'no-store',
    })
  })

  app.use('*', pageGuard)
}
