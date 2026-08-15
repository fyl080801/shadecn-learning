import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AuthVariables } from './auth/middleware.ts'
import { requireAuth, withSession } from './auth/middleware.ts'
import type { ProjectVariables } from './auth/project.ts'
import { appOrigin, isApiPath } from './config.ts'
import { attachPageGuard } from './frontend/guard.ts'
import { auth } from './routes/auth.ts'
import { collab } from './routes/collab.ts'
import { flows } from './routes/flows.ts'
import { health } from './routes/health.ts'
import { invites } from './routes/invites.ts'
import { notes } from './routes/notes.ts'
import { projects } from './routes/projects.ts'

/** 前端中间件要拿到 node 原生的 req/res，所以把 Bindings 绑成 node-server 的 */
export type ServerEnv = { Bindings: HttpBindings; Variables: AuthVariables & ProjectVariables }
export type ServerApp = Hono<ServerEnv>

const app: ServerApp = new Hono<ServerEnv>()

app.use('*', logger())
// 前后端同源，CORS 只放开自己的 origin —— 带 cookie 的接口不能对任意站点开
app.use('/api/*', cors({ origin: appOrigin, credentials: true }))

// 先解析会话，再决定拦不拦。页面也要判登录，所以挂在 '*' 上而不只是 /api/*
app.use('*', withSession)

/** 不需要登录的接口：健康检查和登录流程自己 */
const PUBLIC_API = ['/api/health', '/api/auth']

app.use('/api/*', (c, next) => {
  const path = c.req.path
  if (PUBLIC_API.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next()
  return requireAuth(c, next)
})

const routes = app
  .route('/api/health', health)
  .route('/api/auth', auth)
  .route('/api/notes', notes)
  .route('/api/projects', projects)
  .route('/api/invites', invites)
  .route('/api/flows', flows)
  .route('/api/collab', collab)

// 页面侧的闸门：/login 由服务端渲染，其余非 /api 的请求未登录一律不下发
attachPageGuard(app)

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

export { app, routes }

/** 供前端 `hc<AppType>()` 做端到端类型推导用 */
export type AppType = typeof routes
