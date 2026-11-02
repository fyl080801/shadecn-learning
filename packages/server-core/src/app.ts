import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { appOrigin, isAllowedOrigin, isApiPath, serverRoles } from './config.ts'
import { httpLogger } from './logger/index.ts'
import { platform } from './platform.ts'
import { routeRoleIn, routeTable } from './routes-table.ts'
import { features } from './routes/features.ts'
import { health } from './routes/health.ts'

/**
 * 底座的 HTTP 管线（docs/28 §3.1.1）：请求日志 → CORS → 角色闸门 → 会话解析 → 登录闸门 → 页面守卫 → 底座的两个接口。
 * 会话、登录闸门、页面守卫是平台的 `auth`（由登录模块提供，没有就放行）；模块的接口由 `assemble()` 挂上来，前端托管最后挂（`boot.ts`）——
 * 所以这个文件 import 完时应用还不完整，测试要先装配（`apps/server/test/setup.ts`）。
 *
 * 前端中间件要拿到 node 原生的 req/res，所以把 Bindings 绑成 node-server 的
 */
export type ServerEnv = { Bindings: HttpBindings }
export type ServerApp = Hono<ServerEnv>

const app: ServerApp = new Hono<ServerEnv>()

// 请求日志 + 请求上下文（requestId / userId）。顶掉 hono/logger：
// 那个只往 console 打两行文本，这个带状态码、耗时，并且是 AsyncLocalStorage 的入口，
// 让链路上任何深度的日志都自动带上 requestId（见 ./logger/）
app.use('*', httpLogger())
// 前后端同源，CORS 只放开**自己的那些域名** —— 带 cookie 的接口不能对任意站点开。
// 一套部署可能挂在好几个域名下（SERVER_ORIGINS 白名单），逐个回显；名单外的一律
// 回 SERVER_ORIGIN，也就是不匹配，浏览器自己会拦下
app.use(
  '/api/*',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : appOrigin),
    credentials: true,
  }),
)

/*
 * 路由按角色归属（入口声明推出的归属表，`routes-table.ts`）：本进程不扮演的角色的路由直接 404，说明它归谁 ——
 * 正常不会走到（ingress / dev:cluster 的代理已经分流），走到了说明分流配错了。全部角色一个进程时什么也不拦。
 * 排在会话解析之前：不归这里管的请求不必查会话
 */
app.use('*', async (c, next) => {
  const owner = routeRoleIn(routeTable(), c.req.path)
  if (owner === 'any' || serverRoles.has(owner)) return next()
  return c.json(
    {
      error: 'Not Found',
      message: `本实例（角色 ${[...serverRoles].join(',')}）不提供 ${c.req.path}，它归 ${owner} 角色 —— 检查 ingress 的路径分流`,
    },
    404,
  )
})

// 先解析会话，再决定拦不拦。页面也要判登录，所以挂在 '*' 上而不只是 /api/*
app.use('*', (c, next) => platform.auth.session(c, next))

/*
 * 登录闸门：`/api/*` 默认要登录；入口声明里 `access: 'public'` 的放过 —— 健康检查、登录流程自己，
 * 以及只认 run 短令牌的 agent 网关这类自己鉴权的入口
 */
app.use('/api/*', (c, next) => {
  if (routeTable().match(c.req.path)?.access === 'public') return next()
  return platform.auth.requireUser(c, next)
})

// 页面侧的闸门：非 /api 的整页导航未登录送去登录页（/api 一律放行，它们有上面那道）
app.use('*', (c, next) => (isApiPath(c.req.path) ? next() : platform.auth.pageGuard(c, next)))

// 底座自己的接口。各模块的接口由内核在装配时挂上来（`server.ts` 的 `assemble`，模块 `setup` 里的 `ctx.http.route`）
app.route('/api/health', health).route('/api/features', features)

// 非 /api 的未命中会被前端中间件接走，走到这里的基本只剩接口找不着
app.notFound((c) =>
  isApiPath(c.req.path)
    ? c.json({ error: 'Not Found', path: c.req.path }, 404)
    : c.text('Not Found', 404),
)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal Server Error', message: err.message }, 500)
})

export { app }
