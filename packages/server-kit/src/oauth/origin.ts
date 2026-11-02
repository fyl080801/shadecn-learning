/**
 * 对外域名的判定，纯函数：名单和默认值由调用方给。OAuth 回调地址和 cookie 的 Secure 都靠它，`@shadecn/server-core` 和 `@learning/session` 用同一份。
 */

/**
 * 把一个 origin 归一化成可比较的形式：`协议://host[:非默认端口]`，全小写、去尾斜杠。
 *
 * 比较必须走这一步而不是字符串相等 —— `https://a.com/`、`https://A.com`、
 * `https://a.com:443` 是同一个源，浏览器发 `Origin` 头时给的又永远是最规范的那种写法。
 * 认不出来的（不是合法 URL、不是 http/https）返回 null，一律当不在名单里。
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

export interface OriginHeaders {
  origin?: string | null
  forwardedProto?: string | null
  forwardedHost?: string | null
  host?: string | null
  /** 直连（没有反代）时的协议，用来给 Host 头补上 scheme */
  protocol?: string | null
}

/**
 * 这次请求该用哪个对外地址。
 *
 * 依次看 `X-Forwarded-Proto` + `X-Forwarded-Host`（反代改写过的对外地址）、`Host`、
 * 最后才是 `Origin`（整页导航根本不带这个头，只在 XHR 上有）。取第一个**在白名单里**的；
 * 一个都不在就回落 `fallback`，绝不跟着 `Host` 头走（反代后面它是外部可控的输入）。
 */
export function pickOrigin(headers: OriginHeaders, allowed: readonly string[], fallback: string): string {
  const proto = headers.forwardedProto?.split(',')[0]?.trim() || headers.protocol || 'http'
  const forwardedHost = headers.forwardedHost?.split(',')[0]?.trim()

  const candidates = [
    // 反代改写过的对外地址最贴近「用户在浏览器地址栏里看到的那个域名」
    forwardedHost ? `${proto}://${forwardedHost}` : null,
    headers.host ? `${proto}://${headers.host}` : null,
    // 反代终止了 https 却没给 X-Forwarded-Proto 时的补救
    headers.host ? `https://${headers.host}` : null,
    // 最后才看 Origin：反代把 Host 改成了内网名字时，只有它还认得对外域名
    headers.origin,
  ]

  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate)
    if (origin && allowed.includes(origin)) return origin
  }
  return fallback
}
