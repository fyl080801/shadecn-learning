import { FlowBodyParsers } from '@learning/canvas'
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'

/** 上传接口的路径前缀。文件和分片的字节只有这里收 */
const ASSETS_PATH = /^\/api\/flows\/[^/]+\/assets(\/|\?|$)/

/**
 * 让 Fastify 不解析上传的请求体，字节留在 `req.raw` 上，由控制器在**守卫之后**按上限读（`request-body.ts`）。
 *
 * Fastify 在路由之前就解析请求体，Nest 的守卫都在那之后。如果用 `parseAs: 'buffer'` 或 `@fastify/multipart` 的整包解析，
 * 匿名和非成员也能让服务端先吞下几 MB，再收 401 / 404；上限也只能写在解析器上，错误不经过控制器。
 *
 * 解析器是 `FlowBodyParsers` 那一个，这里只报自己的路径：别的路径照旧 415，和没有这个模块时一样。
 */
@Injectable()
export class AssetBodyParsers implements OnModuleInit {
  constructor(@Inject(FlowBodyParsers) private readonly bodies: FlowBodyParsers) {}

  onModuleInit(): void {
    for (const type of ['multipart/form-data', 'application/octet-stream']) this.bodies.passThrough(type, ASSETS_PATH)
  }
}
