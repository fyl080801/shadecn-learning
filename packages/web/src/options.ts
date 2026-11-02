import type { ConfigService } from '@learning/config'

export const WEB_MODULE_OPTIONS = Symbol('WEB_MODULE_OPTIONS')

/** 页面闸门问「这个请求登录了吗」的注入 token。闸门开着时必须有模块提供它，否则启动报错（见 page-gate.ts） */
export const WEB_PAGE_AUTH = Symbol('WEB_PAGE_AUTH')

export interface WebPageAuth {
  /** 抛错 = 判断不了（比如数据库故障）：页面回 500，既不放行也不当成未登录 */
  isAuthenticated(request: { headers: Record<string, unknown> }): Promise<boolean>
}

export interface WebAuthOptions {
  /** 登录页路径。匿名可访问，必须在 `htmlEntries` 里有自己的入口 */
  loginPath: string
  /** 匿名可访问的其他路径（精确匹配）。文件不存在时回 404，不会回落到受保护的 HTML 入口 */
  publicPaths?: string[]
}

export interface WebModuleOptions {
  /** `dev`：Vite 中间件；`static`：托管 `vite build` 的产物 */
  mode: 'dev' | 'static'
  /** `dev` 模式是 Vite 的 root（vite.config.ts 和 HTML 入口所在目录），`static` 模式是产物目录 */
  root: string
  /** 后端路由前缀，前端不接管这个前缀下的请求。默认 `/api` */
  apiPrefix?: string
  /** 有独立 HTML 入口的路径 → 入口文件名（精确匹配路径）。默认没有 */
  htmlEntries?: Record<string, string>
  /** 其余路径回落到的 HTML 入口。默认 `index.html` */
  fallbackEntry?: string
  /** 页面闸门。`undefined` = 不校验，所有页面匿名可访问，只有 config.yaml 明确写 `web.auth: false` 才会这样 */
  auth?: WebAuthOptions
}

/** 没写或留空走默认值；写了别的类型抛错，不能悄悄用默认值 */
function stringOption(section: Record<string, unknown>, key: string, fallback: string): string {
  const value = section[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`[web] ${key} 必须是字符串`)
  return value.trim() || fallback
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveHtmlEntries(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return { '/login': 'login.html' }
  if (!isMapping(value) || !Object.values(value).every((entry) => typeof entry === 'string')) {
    throw new Error('[web] web.htmlEntries 必须是「路径 → 入口文件名」的映射')
  }
  return value as Record<string, string>
}

/** **默认开启**：只有明确写 `false` 才关。写错类型（比如字符串 "false"）抛错，不猜 */
function resolveAuth(value: unknown): WebAuthOptions | undefined {
  if (value === false) return undefined
  const section = value === undefined || value === null || value === true ? {} : value
  if (!isMapping(section)) throw new Error('[web] web.auth 只能是 false 或映射')
  const publicPaths = section.publicPaths ?? ['/favicon.ico', '/vite.svg']
  if (!Array.isArray(publicPaths) || !publicPaths.every((item) => typeof item === 'string')) {
    throw new Error('[web] web.auth.publicPaths 必须是字符串列表')
  }
  return { loginPath: stringOption(section, 'loginPath', '/login'), publicPaths }
}

/**
 * config.yaml 的 `web` 段。`mode` 不能配，由 `isProduction` 决定；`root` 相对路径按仓库根。
 * 登录页没有自己的入口，就会回落到 fallbackEntry：匿名用户在 /login 拿到受保护的 SPA，所以这里直接拒绝启动。
 */
export function resolveWebOptions(config: ConfigService): WebModuleOptions {
  const section = config.mapping('web')
  const htmlEntries = resolveHtmlEntries(section.htmlEntries)
  const auth = resolveAuth(section.auth)
  if (auth && !Object.hasOwn(htmlEntries, auth.loginPath)) {
    throw new Error(`[web] web.auth.loginPath（${auth.loginPath}）在 web.htmlEntries 里没有入口`)
  }
  const defaultRoot = config.isProduction ? 'output/public' : 'apps/web'
  return {
    mode: config.isProduction ? 'static' : 'dev',
    root: config.resolvePath(stringOption(section, 'root', defaultRoot)),
    apiPrefix: stringOption(section, 'apiPrefix', '/api'),
    htmlEntries,
    fallbackEntry: stringOption(section, 'fallbackEntry', 'index.html'),
    auth,
  }
}

/** 请求 URL 只取路径部分（`/login?redirect=/x` → `/login`） */
export function pathnameOf(url: string | undefined) {
  return (url ?? '/').split('?')[0]
}

export function isBackendPath(options: WebModuleOptions, url: string | undefined) {
  const prefix = options.apiPrefix ?? '/api'
  const pathname = pathnameOf(url)
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function htmlEntriesOf(options: WebModuleOptions) {
  return new Map(Object.entries(options.htmlEntries ?? {}))
}

export function fallbackEntryOf(options: WebModuleOptions) {
  return options.fallbackEntry ?? 'index.html'
}

/** 配了闸门时不能从文件路由直接发出去的文件：所有 HTML，加上名字不以 .html 结尾的入口 */
export function protectedHtmlGlobs(options: WebModuleOptions) {
  return ['**/*.html', fallbackEntryOf(options), ...htmlEntriesOf(options).values()]
}

export function htmlEntryFor(options: WebModuleOptions, url: string | undefined) {
  return htmlEntriesOf(options).get(pathnameOf(url)) ?? fallbackEntryOf(options)
}
