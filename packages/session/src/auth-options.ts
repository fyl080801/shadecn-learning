import type { ConfigService } from '@learning/config'
import { GITHUB_DEFAULT_SCOPE, normalizeOrigin } from './oauth/index.js'
import { stringOption } from './options.js'

/** `auth.oidc` 解析之后的样子，没配是 null。身份模块也要它：续期要换 token，换 token 要 OIDC 的 client（token-refresher.ts） */
export const OIDC_OPTIONS = Symbol('OIDC_OPTIONS')

/** 登录模块的配置，见 {@link ResolvedLoginOptions} */
export const LOGIN_OPTIONS = Symbol('LOGIN_OPTIONS')

/** 登录相关的配置：config.yaml 的 `auth`、`server.origins` 和 `session.loginPath`，密钥只从 .env 取 */
export interface ResolvedLoginOptions {
  /** 回调 origin 的白名单，已归一化。第一个是默认（请求的域名都不在名单里时用它） */
  origins: string[]
  oidc: OidcProviderOptions | null
  github: GithubProviderOptions | null
  /** 登出和登录失败后回到的登录页，默认 `/login` */
  loginPath: string
}

export interface OidcProviderOptions {
  issuer: string
  clientId: string
  /** 空串 = public client，token 端点的请求不带这个字段 */
  clientSecret: string
  scope: string
  buttonLabel: string
}

export interface GithubProviderOptions {
  clientId: string
  clientSecret: string
  scope: string
}

const OIDC_SECRET_ENV = 'PLATFORM_OIDC_CLIENT_SECRET'
const GITHUB_SECRET_ENV = 'PLATFORM_GITHUB_CLIENT_SECRET'
const SECRET_KEYS = ['clientSecret', 'client_secret', 'secret']

// server.port 的校验归 @learning/foundation 的 serverPort；这里只拿它拼开发环境的默认 origin，默认值要和那边一样
const DEFAULT_PORT = 3001

/**
 * 取 `auth.<name>` 段。没写、空段、所有字段都留空都算没配。
 * 写了密钥就拒绝启动：不拒绝的话它会被悄悄忽略，然后报一句「缺 .env」或干脆按 public client 走。错误信息只带字段名，不带值。
 */
function providerSection(auth: Record<string, unknown>, name: string, secretEnv: string): Record<string, unknown> | null {
  const section = auth[name]
  if (section === undefined || section === null) return null
  if (typeof section !== 'object' || Array.isArray(section)) throw new Error(`[session] auth.${name} 必须是映射`)
  const fields = section as Record<string, unknown>
  for (const key of SECRET_KEYS) {
    if (key in fields) {
      throw new Error(`[session] 密钥不能写在 config.yaml 的 auth.${name}.${key}，放到运行目录 .env 的 ${secretEnv}`)
    }
  }
  return Object.values(fields).some((value) => value !== undefined && value !== null && value !== '') ? fields : null
}

/** 没写是空串；写了别的类型抛错，不能悄悄当成没配 */
function stringField(section: Record<string, unknown>, path: string, key: string): string {
  const value = section[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`[session] ${path}.${key} 必须是字符串`)
  return value.trim()
}

function assertComplete(path: string, missing: string[]) {
  if (missing.length > 0) throw new Error(`[session] ${path} 配置不全，缺少 ${missing.join('、')}`)
}

export function resolveOidcOptions(config: ConfigService): OidcProviderOptions | null {
  const section = providerSection(config.mapping('auth'), 'oidc', OIDC_SECRET_ENV)
  const clientSecret = config.env(OIDC_SECRET_ENV) ?? ''
  if (!section) {
    // 只有密钥没有配置：多半是配置段写漏了，当成没配就成了「配了登录却没有按钮」
    if (clientSecret) assertComplete('auth.oidc', ['auth.oidc.issuer', 'auth.oidc.clientId'])
    return null
  }

  const issuer = stringField(section, 'auth.oidc', 'issuer')
  const clientId = stringField(section, 'auth.oidc', 'clientId')
  assertComplete('auth.oidc', [
    ...(issuer ? [] : ['auth.oidc.issuer']),
    ...(clientId ? [] : ['auth.oidc.clientId']),
  ])
  if (!normalizeOrigin(issuer)) throw new Error('[session] auth.oidc.issuer 必须是 http(s) 地址')

  return {
    // 原样保留：OIDC 要求和发现文档里的 issuer 逐字符相等（有的提供方就带尾斜杠），对不上会在第一次登录时报 issuer 不匹配
    issuer,
    clientId,
    clientSecret,
    scope: stringField(section, 'auth.oidc', 'scope') || 'openid profile email',
    buttonLabel: stringField(section, 'auth.oidc', 'buttonLabel') || '使用 OIDC 登录',
  }
}

function resolveGithub(config: ConfigService): GithubProviderOptions | null {
  const section = providerSection(config.mapping('auth'), 'github', GITHUB_SECRET_ENV)
  const clientSecret = config.env(GITHUB_SECRET_ENV) ?? ''
  const clientId = section ? stringField(section, 'auth.github', 'clientId') : ''
  if (!section && !clientSecret) return null
  // OAuth App 一定是 confidential client，没有 secret 就换不了 token
  assertComplete('auth.github', [
    ...(clientId ? [] : ['auth.github.clientId']),
    ...(clientSecret ? [] : [`运行目录 .env 的 ${GITHUB_SECRET_ENV}`]),
  ])
  return { clientId, clientSecret, scope: GITHUB_DEFAULT_SCOPE }
}

/** 列表里的每一项都要是纯 origin：写了路径的多半是把回调地址抄过来了，归一化时会被悄悄丢掉 */
function parseOrigin(value: unknown): string {
  const invalid = () => new Error(`[session] server.origins 里的 ${String(value)} 不是合法的 origin（http(s)://host[:port]，不带路径，不支持通配符）`)
  if (typeof value !== 'string' || value.includes('*')) throw invalid()
  const origin = normalizeOrigin(value)
  const url = origin ? new URL(value.trim()) : null
  if (!origin || !url || url.pathname !== '/' || url.search || url.hash) throw invalid()
  return origin
}

function resolveOrigins(config: ConfigService, hasProvider: boolean): string[] {
  const server = config.mapping('server')
  // apps/server 的写法是单数的 SERVER_ORIGIN，抄过来不会生效，而且不报错
  if (server.origin !== undefined) console.warn('[session] server.origin 不会被读取，白名单要写在列表 server.origins 里')
  const listed = server.origins
  if (listed !== undefined && listed !== null && !Array.isArray(listed)) {
    throw new Error('[session] server.origins 必须是列表')
  }
  if (listed?.length) return [...new Set(listed.map(parseOrigin))]

  // 生产环境猜不出对外域名：回调地址会落到 localhost 上，要到有人登录时才暴露
  if (hasProvider && config.isProduction) {
    throw new Error('[session] 生产环境配了登录方式就必须配 server.origins（回调地址的域名白名单）')
  }
  const port = typeof server.port === 'number' ? server.port : DEFAULT_PORT
  if (hasProvider && port === 0) throw new Error('[session] server.port 是 0 时猜不出回调地址，要配 server.origins')
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
}

/**
 * 两个提供方都没配不算错：登录不可用（`/api/auth/config` 说 `enabled: false`），页面和 /api 仍然全部拦住。
 * 配了一半、把密钥写进 yaml、生产没有白名单都拒绝启动。
 */
export function resolveLoginOptions(config: ConfigService, oidc: OidcProviderOptions | null): ResolvedLoginOptions {
  const github = resolveGithub(config)
  if (!oidc && !github) {
    console.warn('[session] 没有配置登录方式（auth.oidc / auth.github）：没有人能登录，页面和 /api 全部拦住')
  }
  return {
    origins: resolveOrigins(config, Boolean(oidc || github)),
    oidc,
    github,
    loginPath: stringOption(config.mapping('session'), 'loginPath', '/login'),
  }
}
