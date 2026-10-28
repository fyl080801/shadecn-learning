import crypto from 'node:crypto'
import { vi } from 'vitest'

/**
 * 一个假的 Keycloak：discovery / JWKS / token / end_session 四个端点，
 * 全部走 vi.stubGlobal('fetch') 拦截，测试里不会有任何真实网络请求。
 *
 * 这些常量要和 vitest.config.ts 里 server project 的 env 对上。
 */
export const ISSUER = 'https://keycloak.test/realms/test'
export const CLIENT_ID = 'test-client'
export const APP_ORIGIN = 'http://127.0.0.1:3000'
export const REDIRECT_URI = `${APP_ORIGIN}/api/auth/callback`

export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth`
export const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`
export const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`
export const END_SESSION_ENDPOINT = `${ISSUER}/protocol/openid-connect/logout`

export const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  jwks_uri: JWKS_URI,
  end_session_endpoint: END_SESSION_ENDPOINT,
  code_challenge_methods_supported: ['S256'],
}

// ------------------------------------------------------------------ 签名

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

export const KID = 'test-kid'

export const jwksDoc = {
  keys: [
    {
      ...(publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey),
      kid: KID,
      alg: 'RS256',
      use: 'sig',
    },
  ],
}

const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

export function signJwt(
  payload: Record<string, unknown>,
  options: { kid?: string; alg?: string } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' }),
  )
  const body = b64url(JSON.stringify(payload))
  const signature = crypto
    .sign('sha256', Buffer.from(`${header}.${body}`, 'utf8'), privateKey)
    .toString('base64url')
  return `${header}.${body}.${signature}`
}

/** 只编码不签名，用来造「签名对不上」的 token */
export function unsignedJwt(payload: Record<string, unknown>, signature = 'bad-signature') {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url(signature)}`
}

/** 默认合法的 id_token claims，传 overrides 造各种非法情况 */
export function idTokenClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    sub: 'user-1',
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: 'nonce-1',
    sid: 'kc-session-1',
    preferred_username: 'alice',
    email: 'alice@example.com',
    name: 'Alice',
    ...overrides,
  }
}

export function accessTokenWith(roles: { realm?: string[]; client?: string[] } = {}) {
  return signJwt({
    realm_access: { roles: roles.realm ?? [] },
    resource_access: { [CLIENT_ID]: { roles: roles.client ?? [] } },
  })
}

export interface TokenResponseOptions {
  expiresIn?: number
  refreshExpiresIn?: number
  nonce?: string
  claims?: Record<string, unknown>
  roles?: { realm?: string[]; client?: string[] }
  accessToken?: string
  refreshToken?: string | null
  idToken?: string | null
}

/** 造一份 token 端点的成功响应 */
export function tokenResponse(options: TokenResponseOptions = {}) {
  const claims = idTokenClaims({ nonce: options.nonce ?? 'nonce-1', ...options.claims })
  return {
    access_token: options.accessToken ?? accessTokenWith(options.roles),
    token_type: 'Bearer',
    expires_in: options.expiresIn ?? 300,
    refresh_expires_in: options.refreshExpiresIn ?? 1800,
    refresh_token: options.refreshToken === null ? undefined : (options.refreshToken ?? 'refresh-1'),
    id_token: options.idToken === null ? undefined : (options.idToken ?? signJwt(claims)),
    session_state: 'kc-session-1',
  }
}

/**
 * 同一份成功响应，换成 `createSession()` 收的那个形状。
 *
 * 会话层已经不认识 OIDC 的 snake_case 了（GitHub 那条路根本没有 id_token），
 * 换算规则和 `auth/providers/keycloak.ts` 里的 `tokensFrom` 一致。
 */
export function providerTokens(options: TokenResponseOptions = {}) {
  const raw = tokenResponse(options)
  const now = Date.now()
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    idToken: raw.id_token ?? null,
    expiresAt: new Date(now + raw.expires_in * 1000),
    refreshExpiresAt: raw.refresh_expires_in ? new Date(now + raw.refresh_expires_in * 1000) : null,
    sessionState: raw.session_state ?? null,
  }
}

// ------------------------------------------------------------------ fetch 桩

interface StubbedResponse {
  status: number
  body: unknown
  /** 设了就让 fetch 直接抛，模拟连不上 / 超时 */
  throws?: unknown
}

export interface OidcStub {
  /** 按顺序记录所有出站请求，断言「调了几次 token 端点」用 */
  calls: { url: string; body: string | null }[]
  discovery: StubbedResponse
  jwks: StubbedResponse
  token: StubbedResponse
  endSession: StubbedResponse
  /** 只算打到 token 端点的次数 */
  tokenCalls(): number
}

/**
 * 装上假 Keycloak。返回的对象可以随时改 `.token` / `.discovery` 等字段，
 * 下一次请求就按新的返回，用来测失败分支。
 */
export function stubOidcFetch(): OidcStub {
  const stub: OidcStub = {
    calls: [],
    discovery: { status: 200, body: discoveryDoc },
    jwks: { status: 200, body: jwksDoc },
    token: { status: 200, body: tokenResponse() },
    endSession: { status: 204, body: null },
    tokenCalls: () => stub.calls.filter((c) => c.url.startsWith(TOKEN_ENDPOINT)).length,
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const body = init?.body
      stub.calls.push({
        url,
        body:
          typeof body === 'string'
            ? body
            : body instanceof URLSearchParams
              ? body.toString()
              : null,
      })

      const picked = url.startsWith(DISCOVERY_URL)
        ? stub.discovery
        : url.startsWith(JWKS_URI)
          ? stub.jwks
          : url.startsWith(TOKEN_ENDPOINT)
            ? stub.token
            : url.startsWith(END_SESSION_ENDPOINT)
              ? stub.endSession
              : null

      if (!picked) throw new Error(`[test] 未打桩的出站请求：${url}`)
      if (picked.throws !== undefined) throw picked.throws

      return new Response(picked.body === null ? null : JSON.stringify(picked.body), {
        status: picked.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )

  return stub
}

/** 从 Set-Cookie 头里挑出某个 cookie 的值 */
export function cookieValue(res: Response, name: string): string | null {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const [pair] = line.split(';')
    const [key, ...rest] = (pair ?? '').split('=')
    if (key?.trim() === name) return decodeURIComponent(rest.join('='))
  }
  return null
}
