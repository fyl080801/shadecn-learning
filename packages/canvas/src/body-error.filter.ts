import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { INVALID_JSON } from './params.js'

const CANVAS_API = /^\/api\/(projects|invites|flows)(\/|\?|$)/

/** Nest 的 `mapException` 把 Fastify 4xx 错误换成字符串消息的 HttpException；这个包自己抛的 400 响应体都是对象，所以两者分得开 */
function isBodyParseError(exception: unknown): boolean {
  return exception instanceof HttpException && exception.getStatus() === 400 && typeof exception.getResponse() === 'string'
}

/**
 * 请求体不是合法 JSON 时，画布接口回 `{ error: '请求体不是合法 JSON' }`（前端把 `error` 弹给用户）。
 *
 * Fastify 在路由处理之前解析请求体，错误不经过控制器，所以 `@UseFilters` 接不到，只能挂 `APP_FILTER`，再按路径收窄：别的模块的接口保持 Nest 的默认形状。
 */
@Catch()
export class CanvasBodyErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const url = http.getRequest<{ url?: string }>().url ?? ''
    if (CANVAS_API.test(url) && isBodyParseError(exception)) {
      http.getResponse<{ code(status: number): { send(body: unknown): void } }>().code(400).send({ error: INVALID_JSON })
      return
    }
    super.catch(exception, host)
  }
}
