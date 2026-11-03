import { HttpException, Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'

/** 上传接口的路径前缀。文件和分片的字节只有这里收 */
const ASSETS_PATH = /^\/api\/flows\/[^/]+\/assets(\/|\?|$)/

interface FastifyParsers {
  addContentTypeParser(
    type: string,
    parser: (request: { url: string }, payload: unknown, done: (err: Error | null, body?: unknown) => void) => void,
  ): void
}

/**
 * 让 Fastify 不解析上传的请求体，字节留在 `req.raw` 上，由控制器在**守卫之后**按上限读（`request-body.ts`）。
 *
 * Fastify 在路由之前就解析请求体，Nest 的守卫都在那之后。如果用 `parseAs: 'buffer'` 或 `@fastify/multipart` 的整包解析，
 * 匿名和非成员也能让服务端先吞下几 MB，再收 401 / 404；上限也只能写在解析器上，错误不经过控制器。
 *
 * 解析器注册在根实例上（Nest 的路由都在根实例），所以按路径收窄：别的路径照旧 415，和没有这个模块时一样。
 * 只能在 `onModuleInit` 注册：`app.init()` 此时还没 `ready`，路由也还没挂。
 */
@Injectable()
export class AssetBodyParsers implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  onModuleInit(): void {
    const fastify = this.host.httpAdapter.getInstance<FastifyParsers>()
    for (const type of ['multipart/form-data', 'application/octet-stream']) {
      fastify.addContentTypeParser(type, (request, _payload, done) => {
        if (ASSETS_PATH.test(request.url)) done(null, undefined)
        else done(new HttpException('Unsupported Media Type', 415))
      })
    }
  }
}
