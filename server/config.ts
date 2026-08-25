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

/** 应用对外地址：拼 redirect_uri / post_logout_redirect_uri 用 */
export const appOrigin = (process.env.APP_ORIGIN ?? `http://${host}:${port}`).replace(/\/+$/, '')

/** Keycloak / OIDC 配置。issuer 就是 {keycloak}/realms/{realm} */
export const authConfig = {
  issuer: (process.env.KEYCLOAK_ISSUER ?? '').replace(/\/+$/, ''),
  clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
  /** public client（纯 PKCE）留空 */
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
  scope: process.env.KEYCLOAK_SCOPE ?? 'openid profile email',
  redirectUri: `${appOrigin}/api/auth/callback`,
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
  /** https 部署时 cookie 带 Secure */
  secureCookie: appOrigin.startsWith('https://'),
} as const

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
  redirectUri: `${appOrigin}/api/auth/callback`,
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
