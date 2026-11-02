import type { Context, MiddlewareHandler } from 'hono'
import type { LlmProviderTable } from './llm.ts'

/**
 * 底座交给模块的平台能力（docs/28 §3.1.2）—— 模块碰「人、请求、运行环境」只经这里，不 import `apps/server`。
 *
 * 契约在这个包里，实现在底座（`@shadecn/server-core` 的 `platform.ts`；`auth` 由登录模块提供）：宿主在装配模块之前调 {@link configurePlatform}，
 * 模块在 `setup(ctx)` 里经 `ctx.platform` 拿到同一份；模块内部深处（store、鉴权回调）也可以直接调 {@link platform}。
 */

/** 一个已认出的人：给别人看的那份信息（在场头像、会话发起人） */
export interface PlatformIdentity {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * 「人」这件事 —— **由一个模块提供**（`@shadecn/mod-auth`：登录、会话、身份绑定），不是底座写死的：
 * 那个模块 `provides: [AUTH_SERVICE]` 并注册一个 {@link PlatformAuth}，底座的 `platform().auth` 就转给它。
 * 没有任何模块提供时（清单里没有登录模块）：登录未启用、谁都认不出（`userId` = null），管线上的几道闸门放行。
 */
export const AUTH_SERVICE = 'auth'

export interface PlatformAuth {
  /** 是否启用了登录。没启用 = 本地开发：所有请求当成同一个本地开发用户（只限非生产，登录模块在解析配置时校验） */
  readonly enabled: boolean
  /** 这个请求是谁；未登录 = null。没启用登录时给本地开发用户 */
  userId(c: Context): Promise<string | null>
  /**
   * 凭 cookie 头认人 —— 给不经 Hono 中间件链的入口用（WebSocket 握手、定期复验）。
   * 未启用登录 = null（调用方按「放行、无身份」处理，看 {@link enabled}）。
   * `refresh: false` 只认不续期（定期复验不该把一个早就没人用的会话一直续下去）。
   */
  identify(cookieHeader: string | null | undefined, options?: { refresh?: boolean }): Promise<PlatformIdentity | null>
  /** 底座管线挂在所有路由之前：解析会话（不拦截） */
  readonly session: MiddlewareHandler
  /** 底座的登录闸门对 `/api/*`（入口没声明 `public` 的）调它：未登录 401；没启用登录放行 */
  readonly requireUser: MiddlewareHandler
  /** 底座管线对非 `/api` 的请求调它：未登录的整页导航送去登录页（「看不到界面」，不是「拿不到字节」） */
  readonly pageGuard: MiddlewareHandler
  /**
   * 从会话密钥派生一把**用途专属**的密钥（HMAC，`purpose` 做域分隔：派生出的这把和会话 cookie 的签名互不通用）。
   * 没有会话密钥（只可能在开发环境）时，每个用途在本进程内随机一把。
   */
  deriveSecret(purpose: string): string
}

/** 对外域名（`SERVER_ORIGIN` / `SERVER_ORIGINS`）：底座的配置，拼绝对地址、校验 `Origin` 都看它 */
export interface PlatformOrigins {
  /** 应用的主对外地址（`SERVER_ORIGIN`，没配按监听地址） */
  readonly primary: string
  /** 这个 `Origin` 在不在对外域名白名单里（`SERVER_ORIGINS`，含 `SERVER_ORIGIN`） */
  isAllowed(origin: string | null | undefined): boolean
  /** 这次请求认哪个对外地址（白名单内跟着请求走，否则回落 `SERVER_ORIGIN`）：OAuth 回调、分享链接、cookie 的 Secure 都按它 */
  of(c: Context): string
}

/** 这个进程的运行环境：底座解析好的，模块只读 */
export interface RuntimeInfo {
  readonly isDev: boolean
  /** 实例身份（共享层、总线、日志里用） */
  readonly instanceId: string
  /** 监听的地址（agent 的沙箱回连网关要用） */
  readonly host: string
  readonly port: number
  /** 应用根目录（源码 = 仓库根，产物 = cwd） */
  readonly appRoot: string
  /** 数据目录（默认 `<appRoot>/data`） */
  readonly dataDir: string
  /** 是不是 esbuild 产物（定位随产物发布的文件，如 agent 的 runner） */
  readonly isBundle: boolean
  /** 宿主入口所在目录（产物里 = `output/server`） */
  readonly moduleDir: string
  /** 多副本时共享层用的 Redis；单副本 = null */
  readonly redis: { readonly url: string; readonly prefix: string } | null
  /**
   * 语言服务提供方（配置的 `llm.providers`，`./llm.ts`）：底座解析好的表。core 和模块互不 import，这是模块拿到它的唯一入口 ——
   * 模块在 `config.parse(read, runtime)` 里经这里读（agent 的模型、应用表的 text 类应用）
   */
  readonly llmProviders: LlmProviderTable
  /**
   * 读一个**不属于任何配置 schema** 的环境变量 —— 只给两类东西用：名字由别处约定的密钥（各家 SDK 的 `OPENAI_API_KEY`、
   * 模型表里写的 `$ENV`），和编排系统注入的运行环境事实（Downward API 的 `POD_IP`）。
   * 普通配置项一律走模块的配置段（`ctx.config`），不走这里：走这里的值配置文件改不了、启动时也不校验。
   */
  envVar(name: string): string | undefined
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 结构化日志（底座的 winston，带请求上下文、JSON 格式时按字段输出）。
 * 普通的一行话照旧写 `console.*('[前缀] …')` —— console 已被底座接管，自动变成结构化日志；
 * 要带字段（房间、socket、计数）方便检索的才用这个。
 */
export interface PlatformLogger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface Platform {
  readonly auth: PlatformAuth
  readonly origins: PlatformOrigins
  readonly runtime: RuntimeInfo
  readonly log: PlatformLogger
}

let current: Platform | null = null

/** 宿主在装配模块之前调一次（测试里换一份也走这里） */
export function configurePlatform(value: Platform): void {
  current = value
}

export function platform(): Platform {
  if (!current) throw new Error('[platform] 平台能力还没交进来（宿主要先 configurePlatform）')
  return current
}
