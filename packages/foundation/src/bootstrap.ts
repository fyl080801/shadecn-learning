import { ConfigService } from '@learning/config'
import type { NestApplicationOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { type Readiness, registerHealthRoutes } from './health.js'
import { serverHost, serverPort } from './server-options.js'

export interface BootstrapOptions {
  /** 这个服务叫什么，启动日志用 */
  name: string
  /** 透传给 `NestFactory.create`。测试才需要（`abortOnError: false`、`logger: false`） */
  nest?: NestApplicationOptions
  /** `/api/health/ready` 查哪些依赖。不配时这个路径回 404，见 health.ts */
  readiness?: Readiness
}

/** HTTP 关闭时给还没结束的连接留的时间，到了全部断开 */
export const HTTP_CLOSE_GRACE_MS = 5_000

/**
 * 给 HTTP 关闭加上限。`useProcessExit` 要等关闭流程走完才退出，而 `server.close()` 只断空闲连接（Fastify 的 `forceCloseConnections` 默认也只到这一步），于是：
 * - 请求还没结束的连接要等它结束，挂住的就一直等；
 * - **连上之后一个字节都没发的连接不算空闲**，要等 Node 的 `headersTimeout`（60 秒）。浏览器的预连接、连接池里取消掉的请求都会留下这种连接（实测 undici 就会），不是极端情况。
 *
 * 不用 `forceCloseConnections: true`：那会当场掐断还在处理的请求。这里只在 HTTP 关闭开始之后，给它们留一段时间。要在 `listen` 之前调（`ready` 之后 Fastify 不让加钩子）。
 */
export function boundHttpClose(app: NestFastifyApplication): void {
  app.getHttpAdapter().getInstance().addHook('preClose', (done: () => void) => {
    setTimeout(() => app.getHttpServer().closeAllConnections(), HTTP_CLOSE_GRACE_MS).unref()
    done()
  })
}

/**
 * 所有 Nest 服务共用的启动流程：Fastify、关闭钩子（SIGTERM 时走完 Nest 的关闭流程）、`/api/health` 和 `/api/health/ready`、按 `server.port` / `server.host` 监听。
 * 根模块要 import `ConfigModule`，端口是从它读的。
 *
 * Nest 建实例时抛的错默认走 `abortOnError`（记日志后 `process.exit(1)`），到不了这里。这里接得住的是之后的失败（端口或地址不合法、端口被占用）：
 * 这时 ORM 之类已经建好了，先关掉再把错误交给调用方。
 */
export async function bootstrapService(
  rootModule: Parameters<typeof NestFactory.create>[0],
  options: BootstrapOptions,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(rootModule, new FastifyAdapter(), options.nest ?? {})
  // 关闭流程走完后 process.exit(0)，不用默认的 process.kill(self)。默认那样：node 作容器 PID 1 时信号被内核忽略，还有句柄没关就退不掉（实测关完才靠事件循环排空退出，退出码 0）；
  // 经 `npm start` 这类包装时子进程死于信号，包装层报 `command failed` 退出 1（实测）。现在退出码 0 = 关闭流程走完，1 = 关闭时出错（Nest 自己 exit(1)）
  app.enableShutdownHooks([], { useProcessExit: true })
  boundHttpClose(app)
  registerHealthRoutes(app, options.readiness)

  try {
    const config = app.get(ConfigService)
    const host = serverHost(config)
    await (host === undefined ? app.listen(serverPort(config)) : app.listen(serverPort(config), host))
  } catch (err) {
    await app.close().catch(() => undefined)
    throw err
  }
  console.log(`[${options.name}] 已启动：${await app.getUrl()}`)
  return app
}
