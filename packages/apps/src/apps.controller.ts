import { CurrentUser, type SessionUser } from '@learning/session'
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Res } from '@nestjs/common'
import { AppsService } from './apps.service.js'
import { AppError, type AppErrorCode, type AppInfo, type AppOutput, type AppResult } from './contract.js'

const STATUS: Record<AppErrorCode, number> = {
  not_found: 404,
  invalid_params: 400,
  unavailable: 503,
  upstream: 502,
  timeout: 504,
  aborted: 499,
}

/** 错误码 → HTTP 状态。响应体是 `{ error, code }`，前端弹 `error` */
export function httpErrorOf(err: AppError): HttpException {
  return new HttpException({ error: err.message, code: err.code }, STATUS[err.code])
}

const invalidBody = (message: string) => new AppError('invalid_params', message)

function serializeOutput({ data, ...rest }: AppOutput) {
  return data ? { ...rest, dataUrl: `data:${rest.mimeType ?? 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}` } : rest
}

/** 读 `{ params }`；不是对象回 null */
export function paramsFromBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null
  const params = (body as { params?: unknown }).params ?? {}
  return typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : null
}

interface ClosableReply {
  raw: { once(event: 'close', listener: () => void): unknown; writableEnded: boolean }
}

/**
 * `/api/apps`（docs/29 §3.6）：
 * - `GET /` —— 应用列表（不含提供方地址和密钥）；`GET /:appId` —— 一个应用；
 * - `POST /:appId/execute` —— 请求体 `{ params: {...} }`，**同步**等到结果（视频 / 3D 可能要几分钟）。
 *   客户端断开 = 中止这次执行（上游已经建好的任务不撤回）。字节产物在回包里是 `dataUrl`。
 *
 * 登录靠根模块的 `APP_GUARD = ApiSessionGuard`。
 */
@Controller('api/apps')
export class AppsController {
  constructor(@Inject(AppsService) private readonly service: AppsService) {}

  @Get()
  list(): AppInfo[] {
    return this.service.list()
  }

  @Get(':appId')
  get(@Param('appId') appId: string): AppInfo {
    const app = this.service.get(appId)
    if (!app) throw new HttpException({ error: '没有这个应用', code: 'not_found' }, 404)
    return app
  }

  @Post(':appId/execute')
  @HttpCode(200)
  async execute(@Param('appId') appId: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) reply: ClosableReply) {
    const controller = new AbortController()
    // 响应写完之前连接没了 = 调用方不要了。写完之后的 close 不算
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    try {
      const params = paramsFromBody(body)
      if (!params) throw invalidBody('请求体必须是 { params: {...} }')
      const result: AppResult = await this.service.executeApp(appId, params, { signal: controller.signal, userId: user.id })
      return { ...result, outputs: result.outputs.map(serializeOutput) }
    } catch (err) {
      if (err instanceof AppError) throw httpErrorOf(err)
      throw err
    }
  }
}
