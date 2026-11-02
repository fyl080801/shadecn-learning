import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'
import { IS_PUBLIC } from './public.decorator.js'
import { SessionGuard, type SessionRequest } from './session.guard.js'

interface RoutedRequest extends SessionRequest {
  url?: string
  /** Fastify 命中的路由模式 */
  routeOptions?: { url?: string }
}

/**
 * 给 `APP_GUARD` 用的全局守卫：`apiPrefix` 下的路由默认要登录（`@Public()` 是例外），校验逻辑就是 {@link SessionGuard}。
 *
 * 非 `apiPrefix` 的请求放行：页面的回退路由（`@learning/web` 的 HtmlFallbackController）也是 Nest 控制器，
 * 全局守卫挡它会把匿名访问登录页也挡掉；页面由 web 的闸门负责。
 *
 * **不能只看 `request.url`**：Fastify 匹配路由前会解码路径，`GET /%61pi/secret` 命中 `/api/secret`，而 url 还是原文，
 * 只比 url 就成了绕过。所以路由模式和解码后的路径有一个在前缀下就校验。
 */
@Injectable()
export class ApiSessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionGuard) private readonly sessionGuard: SessionGuard,
    @Inject(SESSION_OPTIONS) private readonly options: ResolvedSessionOptions,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true
    if (!this.isApiRequest(context.switchToHttp().getRequest<RoutedRequest>())) return true
    return this.sessionGuard.canActivate(context)
  }

  private isApiRequest(request: RoutedRequest): boolean {
    const { apiPrefix } = this.options
    const underPrefix = (pathname: string | undefined) =>
      pathname === apiPrefix || Boolean(pathname?.startsWith(`${apiPrefix}/`))

    const raw = (request.url ?? '/').split('?')[0]
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // 百分号编码不合法：Fastify 也匹配不到路由，按原文判断
    }
    return underPrefix(request.routeOptions?.url) || underPrefix(decoded)
  }
}
