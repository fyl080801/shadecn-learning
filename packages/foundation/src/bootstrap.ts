import { ConfigService } from '@learning/config'
import type { NestApplicationOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { serverPort } from './server-options.js'

/**
 * 浅探针：只回答「这个进程还在跑吗」，不碰数据库。
 *
 * **直接注册在 Fastify 上，不是 Nest 控制器**，这是有意的（实测，`test/bootstrap.test.ts` 和 `apps/platform/test/app.test.ts` 钉着）：
 * `ApiSessionGuard` 让 `/api` 下的 Nest 路由默认都要登录，控制器得标 `@Public()`，而本包不能依赖 `@learning/session`（反过来也不该：会话不需要知道服务怎么启动）。
 * Fastify 路由走不到 Nest 的守卫、异常过滤器，「公开」和「不依赖任何模块」都是结构上保证的。和前端托管不冲突：
 * `/api` 前缀不进 Vite，静态模式下精确路径优先于 `HtmlFallbackController` 的 `/*`。
 * 业务模块再声明同一个路径，Fastify 启动时就报重复路由。
 */
const HEALTH_PATH = '/api/health'

export interface BootstrapOptions {
  /** 这个服务叫什么，启动日志用 */
  name: string
  /** 透传给 `NestFactory.create`。测试才需要（`abortOnError: false`、`logger: false`） */
  nest?: NestApplicationOptions
}

/**
 * 所有 Nest 服务共用的启动流程：Fastify、关闭钩子（SIGTERM 时走完 Nest 的关闭流程）、`/api/health`、按 `server.port` 监听。
 * 根模块要 import `ConfigModule`，端口是从它读的。
 *
 * Nest 建实例时抛的错默认走 `abortOnError`（记日志后 `process.exit(1)`），到不了这里。这里接得住的是之后的失败（端口不合法、被占用）：
 * 这时 ORM 之类已经建好了，先关掉再把错误交给调用方。
 */
export async function bootstrapService(
  rootModule: Parameters<typeof NestFactory.create>[0],
  options: BootstrapOptions,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(rootModule, new FastifyAdapter(), options.nest ?? {})
  app.enableShutdownHooks()
  app.getHttpAdapter().get(HEALTH_PATH, () =>
    Promise.resolve({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() }),
  )

  try {
    await app.listen(serverPort(app.get(ConfigService)))
  } catch (err) {
    await app.close().catch(() => undefined)
    throw err
  }
  console.log(`[${options.name}] 已启动：${await app.getUrl()}`)
  return app
}
