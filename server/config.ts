import './env.ts'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（server/ 的上一级）：Vite 的 root、index.html、dist 都以它为准 */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 生产构建产物目录 */
export const distDir = path.join(rootDir, 'dist')

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
 * SQLite 文件位置。默认 <dataDir>/app.db；
 * DATABASE_URL 优先级更高，可以整个换掉（相对路径同样按仓库根目录解析，
 * 这样 prisma CLI（在根目录跑）和服务端进程（cwd 可能不同）看到的是同一个库）。
 */
export const databaseUrl = resolveDatabaseUrl(
  process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`,
)

function resolveFromRoot(target: string) {
  return path.isAbsolute(target) ? target : path.join(rootDir, target)
}

function resolveDatabaseUrl(url: string) {
  if (!url.startsWith('file:')) return url
  return `file:${resolveFromRoot(url.slice('file:'.length))}`
}

/** better-sqlite3 不会自动建目录，打开库之前先把父目录补上 */
export function ensureDatabaseDir() {
  if (!databaseUrl.startsWith('file:')) return
  mkdirSync(path.dirname(databaseUrl.slice('file:'.length)), { recursive: true })
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

/** 没配 Keycloak 就退化成「不鉴权」，方便本地只跑前端 demo；生产必须配齐 */
export const authEnabled = Boolean(authConfig.issuer && authConfig.clientId)

/** 启动时校验一次，配置不全在生产直接拒绝启动 */
export function assertAuthConfig() {
  const missing: string[] = []
  if (!authConfig.issuer) missing.push('KEYCLOAK_ISSUER')
  if (!authConfig.clientId) missing.push('KEYCLOAK_CLIENT_ID')
  if (!authConfig.secret) missing.push('SESSION_SECRET')

  if (missing.length === 0) return

  const hint = `缺少环境变量：${missing.join(', ')}（参考 .env.example）`
  if (!isDev) throw new Error(`[auth] ${hint}`)
  console.warn(`[auth] ${hint}`)
  if (!authEnabled) console.warn('[auth] 登录已关闭，所有接口与页面按匿名放行')
}
