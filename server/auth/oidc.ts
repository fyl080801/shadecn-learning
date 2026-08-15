import crypto from 'node:crypto'
import { authConfig } from '../config.ts'

/**
 * 一个够用的 OIDC Authorization Code + PKCE 客户端。
 * 只依赖 node 自带的 crypto 和 fetch —— 端点从 Keycloak 的
 * {issuer}/.well-known/openid-configuration 发现，不写死路径。
 */

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
  code_challenge_methods_supported?: string[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  refresh_expires_in?: number
  id_token?: string
  session_state?: string
  scope?: string
}

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  azp?: string
  nonce?: string
  sid?: string
  session_state?: string
  preferred_username?: string
  email?: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] }>
  [claim: string]: unknown
}

export class OidcError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'OidcError'
  }
}

// ---------------------------------------------------------------- discovery

const DISCOVERY_TTL = 10 * 60 * 1000

let discoveryCache: { at: number; doc: Discovery } | null = null
let discoveryInflight: Promise<Discovery> | null = null

/** 拉一次 discovery 文档并缓存 10 分钟；并发调用共享同一个请求 */
export async function discover(force = false): Promise<Discovery> {
  if (!force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL) {
    return discoveryCache.doc
  }
  discoveryInflight ??= (async () => {
    const url = `${authConfig.issuer}/.well-known/openid-configuration`
    let res: Response
    try {
      res = await fetch(url)
    } catch (err) {
      throw new OidcError(`连不上 Keycloak（${url}）`, err)
    }
    if (!res.ok) throw new OidcError(`discovery 失败：${res.status} ${url}`)

    const doc = (await res.json()) as Discovery
    if (doc.issuer !== authConfig.issuer) {
      throw new OidcError(`issuer 不匹配：配置 ${authConfig.issuer}，实际 ${doc.issuer}`)
    }
    discoveryCache = { at: Date.now(), doc }
    return doc
  })().finally(() => {
    discoveryInflight = null
  })

  return discoveryInflight
}

// -------------------------------------------------------------------- PKCE

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function codeChallengeOf(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// ------------------------------------------------------------ authorize/token

export interface AuthorizeParams {
  state: string
  nonce: string
  codeChallenge: string
  /** 传 'login' 强制重新输密码，'none' 静默探测登录态 */
  prompt?: 'login' | 'none' | 'consent'
}

export async function buildAuthorizationUrl(params: AuthorizeParams) {
  const { authorization_endpoint } = await discover()
  const url = new URL(authorization_endpoint)
  url.searchParams.set('client_id', authConfig.clientId)
  url.searchParams.set('redirect_uri', authConfig.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', authConfig.scope)
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (params.prompt) url.searchParams.set('prompt', params.prompt)
  return url.toString()
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const { token_endpoint } = await discover()
  body.set('client_id', authConfig.clientId)
  // confidential client 用 client_secret_post；public client 不带这个字段
  if (authConfig.clientSecret) body.set('client_secret', authConfig.clientSecret)

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = (await res.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null

  if (!res.ok || !payload?.access_token) {
    const detail = payload?.error_description ?? payload?.error ?? `HTTP ${res.status}`
    throw new OidcError(`token 端点返回失败：${detail}`)
  }
  return payload
}

export function exchangeCode(code: string, codeVerifier: string) {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: authConfig.redirectUri,
      code_verifier: codeVerifier,
    }),
  )
}

export function refreshTokens(refreshToken: string) {
  return postToken(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  )
}

/** 通知 Keycloak 作废 refresh token（对应的 SSO 会话也会结束） */
export async function revokeRefreshToken(refreshToken: string) {
  // 尽力而为：连 discovery 都拉不到就算了，本地会话该清照清，别把登出卡成 500
  let end_session_endpoint: string | undefined
  try {
    ;({ end_session_endpoint } = await discover())
  } catch {
    return
  }
  if (!end_session_endpoint) return
  const body = new URLSearchParams({
    client_id: authConfig.clientId,
    refresh_token: refreshToken,
  })
  if (authConfig.clientSecret) body.set('client_secret', authConfig.clientSecret)
  await fetch(end_session_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }).catch(() => undefined)
}

/** RP-initiated logout：让浏览器跳过去，把 Keycloak 上的 SSO cookie 也清掉 */
export async function buildLogoutUrl(idToken?: string | null) {
  const { end_session_endpoint } = await discover()
  if (!end_session_endpoint) return authConfig.postLogoutRedirectUri

  const url = new URL(end_session_endpoint)
  url.searchParams.set('post_logout_redirect_uri', authConfig.postLogoutRedirectUri)
  // 带上 id_token_hint，Keycloak 才认 post_logout_redirect_uri
  if (idToken) url.searchParams.set('id_token_hint', idToken)
  else url.searchParams.set('client_id', authConfig.clientId)
  return url.toString()
}

// --------------------------------------------------------------- JWT / JWKS

const CLOCK_SKEW = 60 // 秒

interface JwtHeader {
  alg: string
  kid?: string
  typ?: string
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T
}

/** 只解码不验签 —— 用于我们自己刚从 token 端点换回来的 access_token（取角色用） */
export function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return decodeSegment<T>(parts[1])
  } catch {
    return null
  }
}

let jwksCache: { at: number; keys: crypto.JsonWebKey[] } | null = null

async function fetchJwks(force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < DISCOVERY_TTL) return jwksCache.keys
  const { jwks_uri } = await discover()
  const res = await fetch(jwks_uri)
  if (!res.ok) throw new OidcError(`JWKS 拉取失败：${res.status}`)
  const { keys } = (await res.json()) as { keys: crypto.JsonWebKey[] }
  jwksCache = { at: Date.now(), keys }
  return keys
}

async function findKey(kid: string | undefined, alg: string) {
  const match = (keys: crypto.JsonWebKey[]) =>
    keys.find(
      (k) =>
        (kid === undefined || (k as { kid?: string }).kid === kid) &&
        (k.alg === undefined || k.alg === alg),
    )

  const cached = match(await fetchJwks())
  if (cached) return cached
  // 轮换过密钥就再拉一次
  const fresh = match(await fetchJwks(true))
  if (!fresh) throw new OidcError(`JWKS 里找不到 kid=${kid ?? '(未指定)'} 的密钥`)
  return fresh
}

function verifySignature(
  alg: string,
  key: crypto.KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  const hash = `sha${alg.slice(2)}`
  if (alg.startsWith('RS')) return crypto.verify(hash, data, key, signature)
  if (alg.startsWith('PS')) {
    return crypto.verify(
      hash,
      data,
      {
        key,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
    )
  }
  if (alg.startsWith('ES')) {
    // JWS 里 ECDSA 签名是裸 r||s，不是 DER
    return crypto.verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature)
  }
  throw new OidcError(`不支持的签名算法：${alg}`)
}

const SUPPORTED_ALGS = /^(RS|PS|ES)(256|384|512)$/

/**
 * 校验 id_token：签名（JWKS）、iss、aud、exp/iat、nonce。
 * 走的是 code flow，token 是我们自己从 TLS 通道换回来的，
 * 但验一遍能顺手挡住配置串了 realm、nonce 被重放这类问题。
 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
  const parts = idToken.split('.')
  const [rawHeader, rawPayload, rawSignature] = parts
  if (parts.length !== 3 || !rawHeader || !rawPayload || !rawSignature) {
    throw new OidcError('id_token 格式不对')
  }

  const header = decodeSegment<JwtHeader>(rawHeader)
  if (!SUPPORTED_ALGS.test(header.alg)) {
    throw new OidcError(`不支持的 id_token 算法：${header.alg}`)
  }

  const jwk = await findKey(header.kid, header.alg)
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8')

  if (!verifySignature(header.alg, key, signed, Buffer.from(rawSignature, 'base64url'))) {
    throw new OidcError('id_token 签名校验失败')
  }

  const claims = decodeSegment<IdTokenClaims>(rawPayload)
  const now = Math.floor(Date.now() / 1000)

  if (claims.iss !== authConfig.issuer) throw new OidcError('id_token 的 iss 不匹配')

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(authConfig.clientId)) throw new OidcError('id_token 的 aud 不含本 client')
  if (audiences.length > 1 && claims.azp && claims.azp !== authConfig.clientId) {
    throw new OidcError('id_token 的 azp 不是本 client')
  }

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now) {
    throw new OidcError('id_token 已过期')
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW > now) {
    throw new OidcError('id_token 的 iat 在未来')
  }
  if (claims.nonce !== expectedNonce) throw new OidcError('id_token 的 nonce 不匹配')

  return claims
}

/** Keycloak 默认把角色放在 access_token 里，id_token 要加 mapper 才有 */
export function rolesFromAccessToken(accessToken: string): string[] {
  const payload = decodeJwtPayload<IdTokenClaims>(accessToken)
  if (!payload) return []
  const realm = payload.realm_access?.roles ?? []
  const client = payload.resource_access?.[authConfig.clientId]?.roles ?? []
  return [...new Set([...realm, ...client.map((role) => `${authConfig.clientId}:${role}`)])]
}
