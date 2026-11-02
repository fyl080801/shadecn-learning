import { randomBytes } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { AUTH_SERVICE, configurePlatform, type Platform, type PlatformAuth, type RuntimeInfo } from '@shadecn/server-kit/platform'
import {
  appOrigin,
  dataDir,
  host,
  instanceId,
  isAllowedOrigin,
  isClustered,
  isDev,
  llmProviders,
  port,
  redisKeyPrefix,
  redisUrl,
  resolveOrigin,
  rootDir,
} from './config.ts'
import { logger } from './logger/logger.ts'
import { isBundle, moduleDir } from './runtime.ts'

/**
 * 平台能力的实现（docs/28 §3.1.2）：底座交给模块的 `runtime` / `origins` / `log`，以及转给登录模块的 `auth`。
 * import 这个文件就交出了平台能力（`configurePlatform`）。
 */

export const runtime: RuntimeInfo = {
  isDev,
  instanceId,
  host,
  port,
  appRoot: rootDir,
  dataDir,
  isBundle,
  moduleDir,
  redis: isClustered ? { url: redisUrl, prefix: redisKeyPrefix } : null,
  llmProviders,
  envVar: (name) => process.env[name],
}

/** 这次请求认哪个对外地址：白名单内跟着请求走，否则回落 `SERVER_ORIGIN`（规则在 `config.ts` 的 `resolveOrigin`） */
function originOf(c: Context): string {
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

// ---------------------------------------------------------------- auth：由模块提供

const pass: MiddlewareHandler = (_c, next) => next()
const randomSecrets = new Map<string, string>()

/** 没有任何模块提供登录时的样子：未启用、谁都认不出、闸门放行 */
const noAuth: PlatformAuth = {
  enabled: false,
  userId: async () => null,
  identify: async () => null,
  session: pass,
  requireUser: pass,
  pageGuard: pass,
  deriveSecret(purpose) {
    let value = randomSecrets.get(purpose)
    if (value === undefined) randomSecrets.set(purpose, (value = randomBytes(32).toString('hex')))
    return value
  },
}

let provider: PlatformAuth = noAuth

/** 装配时某个模块注册了 `auth` 服务就接上它（`server.ts` 的 `assemble`，经内核的 `onProvide`） */
export function acceptProvidedService(name: string, value: unknown): void {
  if (name === AUTH_SERVICE) provider = value as PlatformAuth
}

/** 测试 / 重新装配前回到「没有登录模块」 */
export function resetAuthProvider(): void {
  provider = noAuth
}

/** 平台的 `auth`：每次调用都转给当前的提供者（模块是在平台交出去之后才 setup 的） */
const auth: PlatformAuth = {
  get enabled() {
    return provider.enabled
  },
  userId: (c) => provider.userId(c),
  identify: (cookieHeader, options) => provider.identify(cookieHeader, options),
  session: (c, next) => provider.session(c, next),
  requireUser: (c, next) => provider.requireUser(c, next),
  pageGuard: (c, next) => provider.pageGuard(c, next),
  deriveSecret: (purpose) => provider.deriveSecret(purpose),
}

export const platform: Platform = {
  auth,
  origins: { primary: appOrigin, isAllowed: (origin) => isAllowedOrigin(origin), of: originOf },
  runtime,
  log: {
    log: (level, message, meta) => void logger.log(level, message, meta),
    debug: (message, meta) => void logger.debug(message, meta),
    info: (message, meta) => void logger.info(message, meta),
    warn: (message, meta) => void logger.warn(message, meta),
    error: (message, meta) => void logger.error(message, meta),
  },
}

configurePlatform(platform)

