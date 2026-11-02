import { randomBytes } from 'node:crypto'
import type { ConfigService } from '@learning/config'

export const SESSION_OPTIONS = Symbol('SESSION_OPTIONS')

/** config.yaml 的 `session` 段解析之后的样子（登录才用的字段在 auth-options.ts） */
export interface ResolvedSessionOptions {
  /** 会话 token 做 HMAC 的密钥 */
  secret: string
  /** 会话最长存活时间（秒），默认 7 天 */
  ttlSeconds: number
  /** 会话 cookie 名，默认 `sid` */
  cookieName: string
  /** `ApiSessionGuard` 校验的路径前缀，默认 `/api`。`AuthController` 的路由固定在 `/api/auth`，前端写死了这个地址 */
  apiPrefix: string
}

/** 没写或留空走默认值；写了别的类型抛错，不能悄悄用默认值 */
export function stringOption(section: Record<string, unknown>, key: string, fallback: string): string {
  const value = section[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`[session] session.${key} 必须是字符串`)
  return value.trim() || fallback
}

const SECRET_ENV = 'PLATFORM_SESSION_SECRET'

/**
 * 密钥只从运行目录的 .env（或环境变量）取。config.yaml 里写了就拒绝启动：不拒绝的话它会被悄悄忽略，开发时变成临时密钥，生产时报一句「没设置」。
 * 生产缺密钥拒绝启动；开发时临时生成一个，重启后所有会话失效。
 */
function resolveSecret(config: ConfigService, section: Record<string, unknown>): string {
  if (section.secret !== undefined && section.secret !== null) {
    throw new Error(`[session] 密钥不能写在 config.yaml 的 session.secret，放到运行目录 .env 的 ${SECRET_ENV}`)
  }
  const secret = config.env(SECRET_ENV)
  if (secret) return secret
  if (config.isProduction) throw new Error(`[session] 生产环境必须在运行目录的 .env 或环境变量里设置 ${SECRET_ENV}`)
  console.warn(`[session] 没有设置 ${SECRET_ENV}，本次运行用临时密钥（重启后会话全部失效）`)
  return randomBytes(32).toString('hex')
}

export function resolveSessionOptions(config: ConfigService): ResolvedSessionOptions {
  const section = config.mapping('session')
  const ttlSeconds = section.ttlSeconds ?? 7 * 24 * 3600
  // 0 / 负数会让所有会话一读就被删，而且不报错
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('[session] session.ttlSeconds 必须是正数')
  }
  return {
    secret: resolveSecret(config, section),
    ttlSeconds,
    cookieName: stringOption(section, 'cookieName', 'sid'),
    apiPrefix: stringOption(section, 'apiPrefix', '/api'),
  }
}
