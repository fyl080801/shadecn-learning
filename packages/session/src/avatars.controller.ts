import { Controller, Get, HttpException, Param, Res } from '@nestjs/common'
import { isIdenticonSeed, renderIdenticon } from './identicon.js'

interface AvatarReply {
  code(statusCode: number): this
  header(name: string, value: string): this
  send(payload: string): unknown
}

/**
 * 默认头像：`GET /api/avatars/<seed>.svg`。没有 `@Public()`，和其它 `/api/*` 一样要登录（docs/02 §3.5.1）。
 * 图完全由种子算出来，没有数据库读写，也不认识请求者是谁，所以按不可变资源缓存：种子变了地址就变了。
 * 归登录模块：协同副本没有这个路由，前置代理也把它分给平台（`apps/collab/scripts/front-proxy.mjs`）。
 */
@Controller('api/avatars')
export class AvatarsController {
  @Get(':seed')
  show(@Param('seed') raw: string, @Res() reply: AvatarReply) {
    const seed = raw.replace(/\.svg$/, '')
    if (!isIdenticonSeed(seed)) throw new HttpException({ error: 'Not Found', message: '头像不存在' }, 404)
    return reply.code(200).header('content-type', 'image/svg+xml; charset=utf-8').header('cache-control', 'public, max-age=31536000, immutable').send(renderIdenticon(seed))
  }
}
