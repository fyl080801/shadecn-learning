import { setTimeout as sleep } from 'node:timers/promises'
import type { INestApplicationContext } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'

/**
 * 两条探针都**直接注册在 Fastify 上，不是 Nest 控制器**，这是有意的（实测，`test/bootstrap.test.ts` 和 `apps/platform/test/app.test.ts` 钉着）：
 * `ApiSessionGuard` 让 `/api` 下的 Nest 路由默认都要登录，控制器得标 `@Public()`，而本包不能依赖 `@learning/session`（反过来也不该：会话不需要知道服务怎么启动）。
 * Fastify 路由走不到 Nest 的守卫、异常过滤器，「公开」和「不依赖任何模块」都是结构上保证的。和前端托管不冲突：
 * `/api` 前缀不进 Vite，静态模式下精确路径优先于 `HtmlFallbackController` 的 `/*`。
 * 业务模块再声明同一个路径，Fastify 启动时就报重复路由。
 */
const HEALTH_PATH = '/api/health'
const READY_PATH = '/api/health/ready'

/** 一项依赖的检查。返回 false 或抛错都算不通 */
export type ReadinessCheck = () => boolean | Promise<boolean>

/** 服务自己决定查哪些依赖（本包不认识数据库和 Redis），拿启动好的应用取 provider */
export type Readiness = (app: INestApplicationContext) => Record<string, ReadinessCheck>

/**
 * 每项检查的超时。**必须自己带**：ORM 的查询没有默认上界，依赖进网络黑洞时这个请求会一直挂着。
 * 比 k8s `readinessProbe.periodSeconds`（10s）窄，自己超时才能回一个说得清的 503。
 */
const CHECK_TIMEOUT_MS = 2000

async function passes(name: string, check: ReadinessCheck): Promise<boolean> {
  const timeout = new AbortController()
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      sleep(CHECK_TIMEOUT_MS, false, { signal: timeout.signal, ref: false }),
    ])
  } catch (err) {
    // 原因只进日志：这个端点匿名可读，连接串、主机名都不该出现在响应里
    console.warn(`[health] readiness：${name} 探测失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    timeout.abort()
  }
}

/**
 * - `/api/health` 是浅探针（liveness / startup），只回答「进程还在跑吗」，不碰任何依赖：重启修不好数据库。
 * - `/api/health/ready` 是深探针（readiness），各项都通才 200，否则 503，响应只说哪项不通。
 *   **没配 `readiness` 的服务回 404**：不能回 200（依赖挂了也显示就绪，流量照来），也不能落到 Nest 变成 401（探针失败的原因就看不懂了）。
 */
export function registerHealthRoutes(app: NestFastifyApplication, readiness: Readiness | undefined): void {
  const adapter = app.getHttpAdapter()
  adapter.get(HEALTH_PATH, () =>
    Promise.resolve({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() }),
  )
  adapter.get(READY_PATH, async (_request: unknown, reply: { code(status: number): void }) => {
    if (!readiness) {
      reply.code(404)
      return { statusCode: 404, message: '这个服务没有配置 readiness' }
    }
    const checks = Object.entries(readiness(app))
    const results = await Promise.all(checks.map(([name, check]) => passes(name, check)))
    const ready = results.every(Boolean)
    reply.code(ready ? 200 : 503)
    return {
      status: ready ? 'ready' : 'not-ready',
      ...Object.fromEntries(checks.map(([name], index) => [name, results[index] ? 'ok' : 'down'])),
    }
  })
}
