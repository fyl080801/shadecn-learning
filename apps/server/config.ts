import './env.ts'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { appRoot, isBundle, moduleDir } from './runtime.ts'

/** 应用根目录：dev 下 Vite 的 root、index.html、data/ 都以它为准 */
export const rootDir = appRoot

/** 构建产物根目录：`pnpm build` 把后端和前端都放这儿 */
export const outputDir = path.join(rootDir, 'output')

/**
 * 后端的静态资源目录 —— 前端 `vite build` 的产物就落在这里，生产模式直接吐它。
 *
 * - 构建产物运行：自己旁边的 output/public（output/server/index.js → ../public）；
 * - 源码运行（tsx，NODE_ENV=production）：output/public；
 * - STATIC_DIR 可整个覆盖（相对路径按应用根目录算）。
 */
export const staticDir = process.env.STATIC_DIR
  ? resolveFromRoot(process.env.STATIC_DIR)
  : isBundle
    ? path.resolve(moduleDir, '..', 'public')
    : path.join(outputDir, 'public')

/** 没显式设 NODE_ENV=production 就按开发处理（开发时由后端挂 Vite 中间件） */
export const isDev = (process.env.NODE_ENV ?? 'development') !== 'production'

export const port = Number(process.env.PORT ?? 3000)
export const host = process.env.HOST ?? '127.0.0.1'

/** /api 与 /api/* —— 这部分永远由 Hono 处理，不交给前端 */
export function isApiPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * 运行时数据目录：SQLite 库放这儿，整个目录已 gitignore。
 * DATA_DIR 可覆盖（相对路径按仓库根目录算，绝对路径直接用），
 * 容器里就是靠它把库指到挂载卷上。
 */
export const dataDir = resolveFromRoot(process.env.DATA_DIR ?? 'data')

/**
 * GalStory 引擎（`gal-story serve`）的地址，例如 `http://127.0.0.1:8000`。
 *
 * **空 = 这块功能没开**（不是配错了）：前端会显示「未配置」并说明该设哪个变量，
 * 而不是把一个连不上的后端渲染成一屏错误 —— 这个仓库里绝大多数人不会跑那个引擎。
 * 末尾的斜杠一律去掉，好让拼路径的地方只有一种写法。
 */
export const galStoryApiUrl = (process.env.GAL_STORY_API_URL ?? '').trim().replace(/\/+$/, '')

/**
 * 代理请求的超时（毫秒）。**必须自己给** —— fetch 默认没有上界，一个卡住的上游会把请求
 * 永远挂着，浏览器那边只看到一个转圈的页面。
 *
 * 缺省 30s 是按**只读口**给的（故事详情、模型配置、存档列表都在百毫秒级）。
 * ⚠️ 将来接对局：`POST /api/saves/{id}/open` 首次要跑建档（归一化 + 公开人物志 + 按 observer
 * 分调的初次印象 + 泄密判定），实测**几十秒到几分钟**，那时这个数要跟着调大，
 * 或者给那一条单独的上界。
 */
export const galStoryTimeoutMs = Number(process.env.GAL_STORY_API_TIMEOUT_MS ?? 30_000)

/**
 * 与 GalStory 引擎之间的共享密钥（`X-Gal-Gateway-Token`）。空 = 不带这个头。
 *
 * 引擎那一侧没有账号体系，属主完全由本服务注入的 `X-Gal-Owner` 决定 —— 也就是说，**谁能直连
 * 引擎，谁就能扮演任何用户**。引擎缺省只听 127.0.0.1，这道密钥是第二层：配了它，绕过本服务
 * 的请求会被引擎 403。同一个值要同时配在引擎的 `GAL_SERVER_GATEWAY_TOKEN` 上。
 */
export const galStoryGatewayToken = (process.env.GAL_STORY_GATEWAY_TOKEN ?? '').trim()

/** 支持的两种库，名字就是 prisma datasource 的 provider 值 */
export type DbProvider = 'sqlite' | 'postgresql'

/**
 * 用哪种库。这段解析必须和 prisma/db-provider.mjs（CLI 侧：迁移、schema 选择）
 * 逐条一致 —— server/ 是独立 TS 项目，引不到仓库根的 .mjs，所以这里是手抄的一份。
 *
 *   1. 显式的 DB_PROVIDER 最优先；
 *   2. 否则看 DATABASE_URL 的协议；
 *   3. 都没有 → sqlite（零外部依赖的默认形态）。
 */
export const dbProvider: DbProvider = resolveProvider()

/**
 * 数据库连接串。
 *
 * - sqlite：默认 <dataDir>/app.db，DATABASE_URL 可整个换掉（相对路径同样按仓库根目录
 *   解析，这样 prisma CLI（在根目录跑）和服务端进程（cwd 可能不同）看到的是同一个文件）；
 * - postgresql：必须给 DATABASE_URL，原样透传给 pg。
 */
export const databaseUrl = resolveDatabaseUrl()

function resolveFromRoot(target: string) {
  return path.isAbsolute(target) ? target : path.join(rootDir, target)
}

/** 从连接串协议反推 provider；认不出来返回 undefined */
function providerFromUrl(url: string | undefined): DbProvider | undefined {
  if (!url) return undefined
  if (url.startsWith('file:')) return 'sqlite'
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgresql'
  return undefined
}

function resolveProvider(): DbProvider {
  const explicit = process.env.DB_PROVIDER?.trim()
  if (explicit) {
    if (explicit !== 'sqlite' && explicit !== 'postgresql') {
      throw new Error(`DB_PROVIDER 只能是 sqlite / postgresql，收到的是 "${explicit}"`)
    }
    return explicit
  }
  return providerFromUrl(process.env.DATABASE_URL?.trim()) ?? 'sqlite'
}

function resolveDatabaseUrl() {
  const configured = process.env.DATABASE_URL?.trim()
  const scheme = providerFromUrl(configured)
  if (configured && scheme && scheme !== dbProvider) {
    throw new Error(`DB_PROVIDER=${dbProvider} 与 DATABASE_URL 的协议（${scheme}）不一致`)
  }

  if (dbProvider === 'postgresql') {
    if (!configured) throw new Error('DB_PROVIDER=postgresql 时必须提供 DATABASE_URL')
    return configured
  }

  const url = configured ?? `file:${path.join(dataDir, 'app.db')}`
  return url.startsWith('file:') ? `file:${resolveFromRoot(url.slice('file:'.length))}` : url
}

/** better-sqlite3 不会自动建目录，打开库之前先把父目录补上（postgres 无事发生） */
export function ensureDatabaseDir() {
  if (!databaseUrl.startsWith('file:')) return
  mkdirSync(path.dirname(databaseUrl.slice('file:'.length)), { recursive: true })
}

/** 单副本（进程内存）还是多副本（Redis 共享） */
export type ClusterMode = 'single' | 'redis'

/**
 * 跑成一个进程还是一群进程。
 *
 * 解析规则和上面的 `dbProvider` 逐条对齐 —— 显式变量最优先，其次看连接串在不在，
 * 都没有就是最省事的那个默认值：
 *
 *   1. 显式的 CLUSTER_MODE 最优先；
 *   2. 否则看 REDIS_URL 有没有；
 *   3. 都没有 → single（零外部依赖的默认形态，一行 Redis 代码都不加载）。
 *
 * **数据库和 Redis 是两件独立的事**：这里不去看 DB_PROVIDER，那边也不看 REDIS_URL。
 * 两者的搭配是否合理由 `assertClusterConfig()` 判，而且只在生产才是硬错误。
 */
export const clusterMode: ClusterMode = resolveClusterMode()
export const isClustered = clusterMode === 'redis'

/** Redis 连接串，形如 redis://[:password@]host:port[/db]。密码走连接串，不另设变量 */
export const redisUrl = process.env.REDIS_URL?.trim() ?? ''

/** 键空间前缀：多个环境共用一台 Redis 时靠它隔离 */
export const redisKeyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || 'shadecn'

/**
 * 这个进程的身份。
 *
 * awareness 的 clientID 归属登记要区分「哪个实例的哪条连接」—— socketId 只在
 * 单个进程里唯一，多副本下必须带上实例前缀，否则两个实例的 socket 撞号，
 * 冒名防线会把正主的更新当成冒用丢掉。日志前缀也用它。
 */
export const instanceId =
  process.env.INSTANCE_ID?.trim() || `${hostname()}-${randomUUID().slice(0, 8)}`

function resolveClusterMode(): ClusterMode {
  const explicit = process.env.CLUSTER_MODE?.trim()
  if (explicit) {
    if (explicit !== 'single' && explicit !== 'redis') {
      throw new Error(`CLUSTER_MODE 只能是 single / redis，收到的是 "${explicit}"`)
    }
    return explicit
  }
  return process.env.REDIS_URL?.trim() ? 'redis' : 'single'
}

/**
 * 启动时校验一次。
 *
 * 两条的性质不一样：
 * - 说要多副本却没给 REDIS_URL —— 这是**配置自相矛盾**，任何环境都直接拒绝启动；
 * - 多副本配着 SQLite —— 真跑多副本时不成立（单文件库没法被多个进程共享），
 *   但本地拿 SQLite + Redis 单进程验证 Redis 那条链路是完全合理的调试姿势，
 *   所以开发环境只警告，生产才拒绝。
 */
export function assertClusterConfig() {
  if (!isClustered) return

  if (!redisUrl) throw new Error('[cluster] CLUSTER_MODE=redis 时必须提供 REDIS_URL')

  if (dbProvider !== 'postgresql') {
    const hint =
      'CLUSTER_MODE=redis 配的却是 SQLite —— 单文件库没法被多个进程/Pod 共享，真要多副本请切 PostgreSQL'
    if (!isDev) throw new Error(`[cluster] ${hint}`)
    console.warn(`[cluster] ${hint}（本地单进程调试可忽略）`)
  }
}

// ------------------------------------------------------------------ 日志

/**
 * 日志级别。`silent` 关掉全部输出。
 *
 * 默认 `info`（**开发环境也一样**）：`debug` 会把每条 SQL、每次落库、每帧协同事件都打出来，
 * 那是排查时临时开的档位，不是日常。
 */
export const logLevel = process.env.LOG_LEVEL?.trim() || 'info'

/**
 * 输出形态。`json` 一行一个对象（给日志采集用），`pretty` 是给人看的带色彩单行。
 *
 * 默认按环境走：生产 json，开发 pretty。容器里如果接了 Loki / ELK，保持 json。
 */
export const logFormat = (process.env.LOG_FORMAT?.trim() || (isDev ? 'pretty' : 'json')) as
  | 'pretty'
  | 'json'

/**
 * 额外写文件的目录（相对路径按仓库根目录算）。**不设 = 只写 stdout**，这也是容器里该有的样子 ——
 * k8s 收的是 stdout，往容器内写文件只会把日志留在一个随 Pod 一起消失的层里。
 */
export const logDir = process.env.LOG_DIR?.trim() ? resolveFromRoot(process.env.LOG_DIR) : ''

/**
 * 请求日志记到什么程度：
 * - `api` —— **默认**。只记 `/api/*`，外加任何路径上的失败（4xx/5xx）和慢请求。
 *   非 API 的成功请求就是静态资源：dev 下 Vite 每个模块一条，一次刷新几百行，纯噪音。
 * - `all` —— 全记，排查静态资源 / 页面守卫时才需要。
 * - `off` —— 一条不记（失败也不记，那时靠 `app.onError`）。
 */
export const logHttp = (process.env.LOG_HTTP?.trim() || 'api') as 'api' | 'all' | 'off'

/** 超过这个毫秒数的请求单独记一条 warn，`api` 模式下即使不是 /api 也记 */
export const logSlowRequestMs = Number(process.env.LOG_SLOW_MS ?? 1000)

/** 超过这个毫秒数的数据库查询记一条 warn。0 = 不记 */
export const logSlowQueryMs = Number(process.env.LOG_SLOW_QUERY_MS ?? 200)

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

/** 应用对外地址：没配 `APP_ORIGIN` 时按监听地址兜底，同时也是白名单的默认成员 */
export const appOrigin =
  normalizeOrigin(process.env.APP_ORIGIN) ?? normalizeOrigin(`http://${host}:${port}`) ?? ''

/**
 * 允许的对外域名白名单。
 *
 * 同一套部署常常挂在好几个域名下（内网域名 / 外网域名 / 老域名 / 裸 IP），
 * 而 OAuth 的 `redirect_uri`、CORS、WebSocket 的 `Origin` 校验都是**绝对地址**，
 * 写死一个 `APP_ORIGIN` 就意味着：从别的域名进来的人，登录会被甩到另一个域名上
 * （cookie 也就落在了那个域名下），或者干脆被提供方以 redirect_uri 不匹配拒掉。
 *
 * 所以这些地方一律改成「按这次请求的域名来」，再用这份名单收口 ——
 * 名单之外的一律回落到 `APP_ORIGIN`，绝不跟着 `Host` 头走。
 * 反代后面 `Host` 是外部可控的输入，无脑相信它就是 host header 注入。
 *
 * 写法：`APP_ORIGINS="https://a.example.com,https://b.example.com"`（逗号或空白分隔）。
 * **不支持通配符**：每个域名的 `/api/auth/callback` 都得在 Keycloak / GitHub 那边
 * 注册成合法回调，通配符只会造出一批注册不了的地址。
 */
export const appOrigins: readonly string[] = (() => {
  const listed = (process.env.APP_ORIGINS ?? '')
    .split(/[\s,]+/)
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => Boolean(item))
  // APP_ORIGIN 永远在名单里：它是兜底值，不在名单里的话回落目标自己就是非法的
  return [...new Set([appOrigin, ...listed].filter(Boolean))]
})()

/** 这个 origin 在名单里吗 */
export function isAllowedOrigin(value: string | null | undefined): boolean {
  const origin = normalizeOrigin(value)
  return Boolean(origin) && appOrigins.includes(origin as string)
}

/**
 * 这次请求该用哪个对外地址。
 *
 * 依次看 `X-Forwarded-Proto` + `X-Forwarded-Host`（反代改写过的对外地址）、`Host`、
 * 最后才是 `Origin`（整页导航根本不带这个头，只在 XHR 上有）。取第一个**在白名单里**的；
 * 一个都不在就回落 `APP_ORIGIN` —— 行为和加这个特性之前完全一样。
 */
export function resolveOrigin(headers: {
  origin?: string | null
  forwardedProto?: string | null
  forwardedHost?: string | null
  host?: string | null
  /** 直连（没有反代）时的协议，用来给 Host 头补上 scheme */
  protocol?: string | null
}): string {
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
    if (origin && appOrigins.includes(origin)) return origin
  }
  return appOrigin
}

/** 某个 origin 下的 OAuth 回调地址。回调只有这一个路径，靠 `AuthRequest.provider` 分发 */
export function callbackUriFor(origin: string) {
  return `${origin}/api/auth/callback`
}

/** Keycloak / OIDC 配置。issuer 就是 {keycloak}/realms/{realm} */
export const authConfig = {
  issuer: (process.env.KEYCLOAK_ISSUER ?? '').replace(/\/+$/, ''),
  clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
  /** public client（纯 PKCE）留空 */
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
  scope: process.env.KEYCLOAK_SCOPE ?? 'openid profile email',
  /** 登出后回到的前端地址 */
  postLogoutRedirectUri: `${appOrigin}/login`,
  /** 会话 cookie 名 */
  cookieName: 'sid',
  /** 授权过程中的临时 cookie 名 */
  txCookieName: 'oidc_tx',
  /** 会话最长存活时间（秒） */
  ttl: Number(process.env.SESSION_TTL ?? 7 * 24 * 3600),
  /** 会话 token 做 HMAC 的密钥：库里存的是 HMAC 结果，光拖库伪造不出 cookie */
  secret: process.env.SESSION_SECRET ?? '',
  /**
   * https 部署时 cookie 带 Secure。
   *
   * 这是**默认值**（拿不到请求上下文时用它）；有 `Context` 的地方一律走
   * `secureCookieFor(originOf(c))` —— 白名单里可以同时有 http 和 https 的域名，
   * 按 `APP_ORIGIN` 一刀切的话，https 那边不带 Secure（浪费一层保护），
   * http 那边带上 Secure（cookie 直接种不下去，表现为「登录成功但还是未登录」）。
   */
  secureCookie: appOrigin.startsWith('https://'),
} as const

/** 这个 origin 下的 cookie 该不该带 Secure */
export function secureCookieFor(origin: string) {
  return origin.startsWith('https://')
}

/**
 * GitHub OAuth App 配置。
 *
 * GitHub 是 **OAuth2 而不是 OIDC**：没有 discovery、没有 JWKS、没有 id_token，
 * 身份要再调一次 `/user` 才拿得到 —— 所以它不能复用 `auth/oidc.ts`，
 * 单独一个 provider 实现（`auth/providers/github.ts`）。
 *
 * 回调地址和 Keycloak 是**同一个** `/api/auth/callback`，靠 `AuthRequest.provider`
 * 分发。这样多接一个提供方不用改 Keycloak 那边已注册的 redirect_uri。
 */
export const githubConfig = {
  clientId: process.env.GITHUB_CLIENT_ID ?? '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  /** 只要读身份：read:user 拿档案，user:email 拿主邮箱（GitHub 可能把邮箱设为私密） */
  scope: process.env.GITHUB_SCOPE ?? 'read:user user:email',
  /** 落进 User.issuer / UserIdentity.issuer 的固定值 */
  issuer: 'https://github.com',
} as const

export const keycloakEnabled = Boolean(authConfig.issuer && authConfig.clientId)
/** OAuth App 一定是 confidential client，没有 secret 就换不了 token */
export const githubEnabled = Boolean(githubConfig.clientId && githubConfig.clientSecret)

/** 一个提供方都没配就退化成「不鉴权」，方便本地只跑前端 demo；生产必须至少配一个 */
export const authEnabled = keycloakEnabled || githubEnabled

/** 启动时校验一次，配置不全在生产直接拒绝启动 */
export function assertAuthConfig() {
  const missing: string[] = []
  // Keycloak 配了一半（只有 issuer 或只有 client id）当成「想配但配漏了」，明确报出来；
  // 两个都空则是「这次不用 Keycloak」，不算缺
  if (authConfig.issuer || authConfig.clientId) {
    if (!authConfig.issuer) missing.push('KEYCLOAK_ISSUER')
    if (!authConfig.clientId) missing.push('KEYCLOAK_CLIENT_ID')
  }
  if (githubConfig.clientId || githubConfig.clientSecret) {
    if (!githubConfig.clientId) missing.push('GITHUB_CLIENT_ID')
    if (!githubConfig.clientSecret) missing.push('GITHUB_CLIENT_SECRET')
  }
  if (!authEnabled) {
    missing.push('KEYCLOAK_ISSUER + KEYCLOAK_CLIENT_ID 或 GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET')
  }
  if (!authConfig.secret) missing.push('SESSION_SECRET')

  if (missing.length === 0) return

  const hint = `缺少环境变量：${missing.join(', ')}（参考 .env.example）`
  if (!isDev) throw new Error(`[auth] ${hint}`)
  console.warn(`[auth] ${hint}`)
  if (!authEnabled) console.warn('[auth] 登录已关闭，所有接口与页面按匿名放行')
}
