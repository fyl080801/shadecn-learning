import { HttpException, Inject, Injectable } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { Readable } from 'node:stream'

type ParserDone = (err: Error | null, body?: unknown) => void

interface FastifyParsers {
  addContentTypeParser(type: string, parser: (request: { url: string }, payload: Readable, done: ParserDone) => void): void
}

type Read = (payload: Readable, done: ParserDone) => void

const tooLarge = () => new HttpException('Payload Too Large', 413)

/** 读成 Buffer，超过上限不再攒。流要读完，否则响应发不出去 */
function readLimited(limit: number): Read {
  return (payload, done) => {
    const chunks: Buffer[] = []
    let size = 0
    payload.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    payload.on('error', done)
    payload.on('end', () => (size > limit ? done(tooLarge()) : done(null, Buffer.concat(chunks, size))))
  }
}

/**
 * `/api/flows/:flowId/<x>` 下收非 JSON 请求体的路由，共用 Fastify 的解析器。
 *
 * **一个 content-type 在 Fastify 上只能有一个解析器**，第二次注册直接抛错，而协同的 `/doc`（要 Buffer）和上传（要原始流）都收 `application/octet-stream`，又同在 `AppModule` 一个进程里。
 * 谁先注册还取决于模块在图里的距离：后到的要么起不来，要么被先到的解析器回 415（实测 `POST /doc` 就这样失败过）。所以解析器只有这一个，按路径分派，两边各报各的路径，和注册先后无关。
 *
 * 放 canvas 是因为两边都 import 它，这些路由也都叠它的 `FlowMemberGuard`；这里不认识它们。
 * 只能在 `onModuleInit` 里用：`app.init()` 此时还没 `ready`（`ready` 之后 Fastify 不让加解析器）。路径之外照旧 415，和没注册一样。
 */
@Injectable()
export class FlowBodyParsers {
  private readonly routes = new Map<string, { path: RegExp; read: Read }[]>()

  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  /** 这个路径的请求体 Fastify 不碰，字节留在 `req.raw` 上，控制器在守卫之后自己按上限读 */
  passThrough(contentType: string, path: RegExp): void {
    this.add(contentType, path, (_payload, done) => done(null, undefined))
  }

  /** 这个路径的请求体读成 Buffer。解析在路由之前跑：超过上限在这里就是 413，轮不到守卫 */
  buffered(contentType: string, path: RegExp, limit: number): void {
    this.add(contentType, path, readLimited(limit))
  }

  private add(contentType: string, path: RegExp, read: Read): void {
    let routes = this.routes.get(contentType)
    if (!routes) {
      routes = []
      this.routes.set(contentType, routes)
      const registered = routes
      this.host.httpAdapter.getInstance<FastifyParsers>().addContentTypeParser(contentType, (request, payload, done) => {
        const route = registered.find((item) => item.path.test(request.url))
        if (route) route.read(payload, done)
        else done(new HttpException('Unsupported Media Type', 415))
      })
    }
    routes.push({ path, read })
  }
}
