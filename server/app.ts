import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { isApiPath } from './config.ts'
import { collab } from './routes/collab.ts'
import { health } from './routes/health.ts'
import { notes } from './routes/notes.ts'

/** 前端中间件要拿到 node 原生的 req/res，所以把 Bindings 绑成 node-server 的 */
export type ServerEnv = { Bindings: HttpBindings }
export type ServerApp = Hono<ServerEnv>

const app: ServerApp = new Hono<ServerEnv>()

app.use('*', logger())
// 前后端已经同源了，CORS 只是为了别的客户端直连 :3000 调试方便
app.use('/api/*', cors())

const routes = app
  .route('/api/health', health)
  .route('/api/notes', notes)
  .route('/api/collab', collab)

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
