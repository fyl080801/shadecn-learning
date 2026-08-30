import type { Context } from 'hono'
import { resolveOrigin } from '../config.ts'

/**
 * 这次请求认哪个对外地址 —— 所有需要**绝对地址**的地方（OAuth 的 `redirect_uri`、
 * 分享链接、CORS、cookie 的 Secure）都从这里取，不再直接读 `APP_ORIGIN`。
 *
 * 一套部署挂多个域名是常态（内网一个、外网一个、老域名再一个）。写死 `APP_ORIGIN`
 * 的后果是：从别的域名点「登录」，人会被甩到 `APP_ORIGIN` 那个域名上完成回调，
 * 会话 cookie 也就种在了那个域名下 —— 回到原来的域名照样是未登录。
 *
 * 但**不能无脑跟着 `Host` 走**：反代后面 `Host` / `X-Forwarded-Host` 都是外部
 * 可控的输入，跟着它拼 `redirect_uri` 就是把授权码送去攻击者的域名。
 * 所以这里只认 `APP_ORIGINS` 白名单里的域名，其余一律回落 `APP_ORIGIN`
 * （行为与没有这份名单时完全一致）。
 */
export function originOf(c: Context): string {
  // 直连（没有反代）时的协议，用来给 Host 头补上 scheme
  const protocol = (() => {
    try {
      return new URL(c.req.url).protocol.replace(/:$/, '')
    } catch {
      return null
    }
  })()

  return resolveOrigin({
    origin: c.req.header('origin'),
    forwardedProto: c.req.header('x-forwarded-proto'),
    forwardedHost: c.req.header('x-forwarded-host'),
    host: c.req.header('host'),
    protocol,
  })
}
