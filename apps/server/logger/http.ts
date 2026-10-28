import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { isApiPath, logHttp, logSlowRequestMs } from '../config.ts'
import { runWithContext, setContextUser } from './context.ts'
import { errorFields, logger } from './logger.ts'

/**
 * 请求日志 —— 顶掉 `hono/logger`，一条请求一行，带状态码、耗时、requestId。
 *
 * **它是一个中间件，不是散在路由里的日志调用**：挂一次就覆盖所有接口，
 * 以后新增路由不用记得加日志。同时它也是请求上下文的入口 ——
 * `runWithContext` 在这里开，链上任何深度的 `console.*` 都会自动带上 requestId。
 *
 * 噪音控制在 `LOG_HTTP` 上（见 config）：默认只记 `/api/*`，
 * 外加**任何路径**上的失败和慢请求。dev 下 Vite 一次刷新几百个模块请求，
 * 全记等于把日志变成一堵墙，而那堵墙里没有一行是有用的。
 */

/** 上游给的追踪 id 优先用；没有才自己生成，这样反代 / 网关的链路能接上 */
const INBOUND_ID_HEADERS = ['x-request-id', 'x-correlation-id', 'traceparent']

function inboundId(header: (name: string) => string | undefined): string | undefined {
  for (const name of INBOUND_ID_HEADERS) {
    const value = header(name)?.trim()
    if (value) return value.slice(0, 128)
  }
  return undefined
}

export function httpLogger(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = inboundId((name) => c.req.header(name)) ?? randomUUID()
    const startedAt = Date.now()
    const { method } = c.req
    const path = c.req.path

    // 让下游（前端、日志系统）也能拿到同一个 id 去对账
    c.header('x-request-id', requestId)

    await runWithContext({ requestId, method, path, startedAt }, async () => {
      try {
        await next()
      } catch (error) {
        // 让 app.onError 照常处理，这里只负责记一笔带上下文的
        logger.error('请求处理抛出异常', {
          module: 'http',
          requestId,
          method,
          path,
          ms: Date.now() - startedAt,
          ...errorFields(error),
        })
        throw error
      }

      /*
       * 会话是 `withSession` 在 next() 里解析出来的，所以用户只能在这时候回填。
       * 回填的是**同一个**上下文对象，之前写出去的日志不受影响 —— 那些日志确实
       * 发生在「还不知道是谁」的时候。
       */
      const user = c.get('user') as { id?: string } | undefined
      if (user?.id) setContextUser(user.id)

      const ms = Date.now() - startedAt
      const status = c.res.status
      const slow = ms >= logSlowRequestMs

      if (!shouldLog(path, status, slow)) return

      const level = status >= 500 ? 'error' : status >= 400 || slow ? 'warn' : 'info'
      logger.log(level, `${method} ${path} ${status}`, {
        module: 'http',
        requestId,
        userId: user?.id,
        method,
        path,
        status,
        ms,
        ...(slow ? { slow: true } : {}),
      })
    })
  }
}

/**
 * 这条请求该不该记。
 *
 * 失败和慢请求**永远**记 —— 它们正是「日志开小一点」时最不该被省掉的那部分，
 * 也是 `api` 这个默认值敢把静态资源全部丢掉的前提。
 */
function shouldLog(path: string, status: number, slow: boolean): boolean {
  if (logHttp === 'off') return false
  if (logHttp === 'all') return true
  return isApiPath(path) || status >= 400 || slow
}
