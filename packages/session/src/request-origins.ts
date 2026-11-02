import { ConfigService } from '@learning/config'
import { Inject, Injectable } from '@nestjs/common'
import { resolveOrigins } from './auth-options.js'
import { pickOrigin } from './oauth/index.js'

/** 判定对外地址要读的那部分请求对象。不依赖 Fastify 的类型 */
export interface OriginRequest {
  headers: Record<string, unknown>
  /** Fastify：直连时看连接本身，开了 trustProxy 才看 X-Forwarded-Proto。只用来给 Host 补 scheme，Secure 看白名单判定出的 origin */
  protocol?: string
}

export function headerValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
}

/** 这次请求认哪个对外地址：只在白名单内跟着请求走，绝不盲信 Host */
export function originOfRequest(request: OriginRequest, origins: readonly string[]): string {
  const { headers } = request
  return pickOrigin(
    {
      origin: headerValue(headers.origin),
      forwardedProto: headerValue(headers['x-forwarded-proto']),
      forwardedHost: headerValue(headers['x-forwarded-host']),
      host: headerValue(headers.host),
      protocol: request.protocol,
    },
    origins,
    origins[0],
  )
}

/**
 * `server.origins` 白名单和按请求判定对外地址，给不跑登录流程也要用它的地方（分享链接的 URL）。
 * 没配白名单时回落本机地址：是否必须配由登录模块判（`resolveLoginOptions`），它在没有登录方式时同样不要求。
 */
@Injectable()
export class RequestOrigins {
  /** 已归一化，第一个是默认 */
  readonly list: string[]

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.list = resolveOrigins(config, false)
  }

  of(request: OriginRequest): string {
    return originOfRequest(request, this.list)
  }
}
