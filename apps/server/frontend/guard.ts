import type { MiddlewareHandler } from 'hono'
import type { ServerApp, ServerEnv } from '../app.ts'
import { safeRedirect } from '../auth/redirect.ts'
import { authEnabled, isApiPath } from '../config.ts'
import { LOGIN_DONE_PATH, renderLoginDonePage } from './login-done-page.ts'

/**
 * 登录页是**前端 bundle 的第二个入口**（`login.html`），不是 SPA 路由 ——
 * SPA 路由表里没有 `/login`，它跟 `index.html` 是并列关系而不是从属关系。
 */
export const LOGIN_PATH = '/login'

/**
 * 匿名浏览器能**导航**到的非 /api 路径。
 * 其余页面（`/`、`/projects`、`/flows/:id`…）一律先回登录页。
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
 * 前端中间件之前。
 *
 * **它守的是「看不到界面」，不是「拿不到字节」。** 未登录时任何一次整页导航都
 * 落回登录页，所以 `index.html` 发不出去、SPA 也就无从启动；而 js/css/字体这些
 * 静态资源匿名放行 —— 光有 bundle 没有 `index.html` 渲染不出任何东西。
 *
 * 之所以必须放行，是因为**登录页本身就是前端 bundle 的一个入口**
 * （`login.html` + `src/login/`，见 vite.config.ts 的 MPA 双入口）：
 * 把资源一起挡掉，登录页自己就白屏了。
 */
export const pageGuard: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (isApiPath(c.req.path)) return next()
  if (!authEnabled) return next()
  if (PUBLIC_PAGES.has(c.req.path)) return next()
  if (c.get('user')) return next()

  // 不是整页导航（js / css / 字体 / 图片 / XHR）就放行。
  // 顺带也避免了「给一个 .js 请求回 HTML」那种让浏览器报解析错误的老问题
  if (!isNavigation(c.req.raw.headers, c.req.method)) return next()

  return c.redirect(loginPathFor(pathWithQuery(c.req.url)), 302)
}

/** 挂登录页 + 页面闸门。要在 /api 路由挂完之后调用 */
export function attachPageGuard(app: ServerApp) {
  /**
   * 登录页这里**只管一件事**：已经登录的人别停在登录页。
   *
   * 页面本体不在这儿渲染了 —— 它是 `login.html` 这个 Vite 入口，由前端层
   * （dev 的 Vite 中间件 / prod 的静态目录）发出来，和 `index.html` 同一条路。
   * `?redirect=` / `?error=` 由页面自己从 `location.search` 读。
   */
  app.get(LOGIN_PATH, async (c, next) => {
    if (authEnabled && c.get('user')) {
      return c.redirect(safeRedirect(c.req.query('redirect')), 302)
    }
    await next()
  })

  app.use('*', pageGuard)

  // 挂在闸门之后：没登录成功就还是会被送回 /login（登录窗口里再登一次），
  // 所以能看到这一页本身就说明会话已经建起来了
  app.get(LOGIN_DONE_PATH, (c) =>
    c.html(renderLoginDonePage(), 200, { 'cache-control': 'no-store' }),
  )
}
