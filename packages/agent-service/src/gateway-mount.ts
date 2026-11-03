import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_GATEWAY_PATH } from '@learning/agent-core/protocol'
import type { AgentRuntime } from '@learning/agent-core/session'
import { type BeforeApplicationShutdown, Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { AGENT_RUNTIME } from './sandbox.js'

/** 这里用到的那一点 Fastify（本包不依赖 fastify） */
interface GatewayScope {
  removeAllContentTypeParsers(): void
  addContentTypeParser(type: string, parser: (request: unknown, payload: unknown, done: (err: Error | null) => void) => void): void
  all(path: string, handler: (request: { raw: IncomingMessage }, reply: { hijack(): unknown; raw: ServerResponse }) => Promise<void>): void
  register(plugin: (scope: GatewayScope) => Promise<void>, options: { prefix: string }): unknown
}

/**
 * 请求体：网关读一块才从 socket 读一块。不用 `Readable.toWeb(req)`：
 * 网关超限时 `reader.cancel()` 会连 `req` 一起销毁，这个 keep-alive 连接要么断在响应之前，要么留在半读的状态，下一个请求就卡死在上面（实测）。
 * 取消时把剩下的丢掉：响应发得出去，连接也还能用。一次都没读（令牌不对）就什么也不碰，Node 在响应结束后自己丢。
 */
function bodyOf(req: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks = req.iterator({ destroyOnReturn: false })
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = (await chunks.next()) as IteratorResult<Buffer>
        if (done) controller.close()
        else controller.enqueue(value)
      },
      async cancel() {
        await chunks.return?.()
        req.resume()
      },
    },
    { highWaterMark: 0 },
  )
}

function requestOf(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers()
  for (let index = 0; index < req.rawHeaders.length; index += 2) headers.append(req.rawHeaders[index]!, req.rawHeaders[index + 1]!)
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(`http://gateway.internal${req.url ?? '/'}`, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: bodyOf(req), duplex: 'half' as const } : {}),
  } as RequestInit)
}

/** 缓冲写满了就等它排空。连接断了 `drain` 不会再来，所以也等 `close` */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/**
 * 把网关的 `Response` 写进 `reply.raw`。
 *
 * - **背压**：只有写得进去才读下一块。不等的话，runner 读得慢时上游的流全部堆在服务端内存里；
 * - **连接断了就 `reader.cancel()`**：取消一路传到 `gateway.ts` 的 body，由它掐断上游、结束「在途」。空闲上限靠这个判断（`.claude/rules/agent.md`），漏了的话 runner 崩掉后这一轮一直算在途，空闲上限永远到不了。
 */
async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  // SSE 的第一帧可能很久以后才有，runner 要先拿到响应头
  res.flushHeaders()
  const reader = response.body.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  res.once('close', cancel)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || res.destroyed) break
      if (!res.write(value)) await drained(res)
    }
    res.end()
  } finally {
    res.off('close', cancel)
  }
}

/**
 * 沙箱里的 runner 够得着服务端的唯一入口（docs/22 §4）：`/api/agent-gateway/*`。协议和实现都在 agent-core，这里只是挂载点。
 *
 * **不走 Nest 控制器**，所以 `ApiSessionGuard` 和异常过滤器都管不到它（同 `@learning/foundation` 的探针）。这是有意的：这里只认 `Authorization: Bearer <run 短令牌>`，浏览器的会话 cookie 一文不值，也就没有 CSRF 的问题；每次调用由网关按 Grant 实时判权。
 *
 * **封装作用域 + 直通解析器**：Fastify 在路由之前解析请求体，默认 JSON 上限 1MB，而网关要 4MB（事件一批、工具参数），并且由网关自己边读边数。`removeAllContentTypeParsers` 只影响这个作用域，别的路由的坏 JSON（400）和 1MB 上限（413）都不变。
 *
 * **时机**：`app.init()` 里 Nest 的路由先注册，再跑 `onModuleInit`，`ready` 要等到 `listen` 或 `inject`，所以这里 `register` 来得及（`ready` 之后 Fastify 会抛错）。不 await：插件等 `ready` 时才加载，这里不需要提前。
 */
@Injectable()
export class AgentGatewayMount implements OnModuleInit, BeforeApplicationShutdown {
  private readonly inFlight = new Set<ServerResponse>()

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
  ) {}

  onModuleInit(): void {
    this.host.httpAdapter.getInstance<GatewayScope>().register(
      async (scope) => {
        scope.removeAllContentTypeParsers()
        // 请求体原样留在 req.raw 上，交给网关读
        scope.addContentTypeParser('*', (_request, _payload, done) => done(null))
        scope.all('/*', async (request, reply) => {
          reply.hijack()
          await this.forward(request.raw, reply.raw)
        })
      },
      { prefix: AGENT_GATEWAY_PATH },
    )
  }

  /**
   * 还没结束的网关请求全部断开。走到这里 `abortAll` 已经结束，这些请求的轮次要么收完尾了，要么超过上限不等了；留着的话 `app.close()` 不返回。
   * 不放在 `onModuleDestroy`：`abortAll` 收尾期间 runner 的请求还要能结束。
   */
  beforeApplicationShutdown(): void {
    for (const res of this.inFlight) res.destroy()
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const disconnected = new AbortController()
    this.inFlight.add(res)
    // 写失败等于断开，由 close 那条路收尾。没有监听者时 error 事件会让进程崩掉
    res.on('error', () => undefined)
    res.once('close', () => {
      this.inFlight.delete(res)
      if (!res.writableFinished) disconnected.abort()
    })
    try {
      await writeResponse(await this.runtime.gateway.handle(requestOf(req, disconnected.signal)), res)
    } catch (err) {
      // handle 自己不抛；到这里多半是上游的流中途出错。响应头已经发了就只能断开，runner 据此判断这次请求失败
      console.error('[agent-gateway] 写响应失败', err)
      if (res.headersSent) res.destroy()
      else res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'bad_request', message: '网关内部错误' }))
    }
  }
}
