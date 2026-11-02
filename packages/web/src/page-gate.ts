import path from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import {
  fallbackEntryOf,
  htmlEntriesOf,
  pathnameOf,
  WEB_MODULE_OPTIONS,
  WEB_PAGE_AUTH,
  type WebModuleOptions,
  type WebPageAuth,
} from './options.js'

/**
 * 页面闸门：要发 HTML 之前的那一个判定，static 的 HtmlFallbackController 和 dev 的 ViteHost.sendHtml 共用。
 *
 * **它守的是「看不到界面」**：js / css / 字体 / 图片匿名放行，因为登录页和 SPA 是同一个 bundle 的两个入口，把资源挡掉登录页自己就白屏了；
 * 光有 bundle 没有入口 HTML 渲染不出任何东西。所以判定点在发 HTML 这里，不看 Accept / Sec-Fetch，也不用 Nest 守卫
 * （dev 的 Vite 中间件跑在路由匹配之前）。
 *
 * 能绕开这个判定的路径（文件路由、Vite 的 /@fs 等）由两边的 host 堵住，见 static-host.ts 和 vite-host.ts。
 */
export type PageAccess = { kind: 'send' } | { kind: 'redirect'; location: string } | { kind: 'not-found' }

/**
 * `?redirect=` 只认站内路径，其余回 `/`。语义同 `@shadecn/mod-auth` 的 safeRedirect，多挡一类：
 * 带控制字符的（`/<TAB>/evil.com`：Node 允许响应头里有 TAB，浏览器解析 URL 时会把它删掉，就成了 `//evil.com`）。
 * 非 ASCII 和空格转义后再用，否则写响应头时 Node 抛 ERR_INVALID_CHAR。
 */
export function safeRedirect(target: string | null | undefined): string {
  if (!target || !target.startsWith('/')) return '/'
  if (target.startsWith('//') || target.startsWith('/\\')) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return '/'
  return target.replace(/[^!-~]+/g, encodeURIComponent)
}

/**
 * 这个请求指向的是不是 HTML 文件。Vite 和 sirv 会自己解码、丢掉 `?` `#` 后面的部分、规整路径，所以这里按它们能看到的最终路径判断：
 * 解到不再变为止（`%3F` 解开之后才是查询串），规整之后看后缀或入口文件名。宁可多判：多判的请求只是走一遍闸门。
 */
export function isHtmlFilePath(options: WebModuleOptions, url: string | undefined): boolean {
  let current = (url ?? '/').replace(/[?#].*$/s, '')
  for (let round = 0; round < 5; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      break
    }
    decoded = decoded.replace(/[?#].*$/s, '')
    if (decoded === current) break
    current = decoded
  }
  const normalized = path.posix.normalize(current.replaceAll('\\', '/')).replace(/\/+$/, '').toLowerCase()
  if (normalized.endsWith('.html')) return true
  return [fallbackEntryOf(options), ...htmlEntriesOf(options).values()].some((entry) =>
    normalized.endsWith(`/${entry.toLowerCase()}`),
  )
}

@Injectable()
export class PageGate {
  private auth: WebPageAuth | null = null

  constructor(
    @Inject(WEB_MODULE_OPTIONS) private readonly options: WebModuleOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * 接上 `WEB_PAGE_AUTH`，由 host 在 onModuleInit 开头调。闸门开着却没人提供就抛错，启动失败。
   *
   * 不用构造函数注入：`web.auth: false` 时不该要求有人提供这个 token。也不用 `@Optional()`：可选依赖解析时**抛的任何错都会被 Nest 吞掉**，
   * 换成 undefined，于是 SessionService 那条链上的真实错误（缺密钥、表结构有损）都变成一句误导人的「没人提供」。
   * 也不能放在 provider 工厂里 `moduleRef.get`：那时对方的工厂可能还没跑完，拿到的是空实例。onModuleInit 在所有 provider 建好之后。
   */
  connect(): void {
    if (!this.options.auth) return
    try {
      this.auth = this.moduleRef.get<WebPageAuth>(WEB_PAGE_AUTH, { strict: false })
    } catch (cause) {
      throw new Error('[web] 页面闸门开着（web.auth 不是 false），但没有模块提供 WEB_PAGE_AUTH', { cause })
    }
  }

  /** 不接 `isAuthenticated` 的异常：判断不了就让调用方回 500，不能放行，也不能说成未登录 */
  async check(request: { url: string | undefined; headers: Record<string, unknown> }): Promise<PageAccess> {
    const config = this.options.auth
    if (!config) return { kind: 'send' }
    // connect() 没跑过就有请求进来：判断不了，不放行
    if (!this.auth) throw new Error('[web] 页面闸门还没有接上 WEB_PAGE_AUTH')

    const url = request.url ?? '/'
    const pathname = pathnameOf(url)

    if (pathname === config.loginPath) {
      if (!(await this.auth.isAuthenticated(request))) return { kind: 'send' }
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
      return { kind: 'redirect', location: safeRedirect(new URLSearchParams(query).get('redirect')) }
    }

    if (config.publicPaths?.includes(pathname)) {
      // 走到这里说明对应的文件不存在。公开路径没有自己的入口时不能回落到 fallbackEntry，那是受保护的 HTML
      return htmlEntriesOf(this.options).has(pathname) ? { kind: 'send' } : { kind: 'not-found' }
    }

    if (await this.auth.isAuthenticated(request)) return { kind: 'send' }
    return { kind: 'redirect', location: `${config.loginPath}?redirect=${encodeURIComponent(safeRedirect(url))}` }
  }
}
