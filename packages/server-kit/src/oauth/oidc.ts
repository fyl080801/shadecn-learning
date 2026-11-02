import crypto from 'node:crypto'
import { HTTP_TIMEOUT, OidcError, type ProviderProfile, type ProviderTokens } from './types.ts'

/**
 * 一个够用的 OIDC Authorization Code + PKCE 客户端。
 * 只依赖 node 自带的 crypto 和 fetch —— 端点从 {issuer}/.well-known/openid-configuration 发现，不写死路径。
 *
 * **不碰配置、实体和全局状态**：配置由调用方的 getter 给（调用时才读），发现文档和 JWKS 的缓存跟着 {@link createOidcClient} 返回的实例走。
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

export interface OidcClientConfig {
  issuer: string
  clientId: string
  /** public client 是空串：token 端点的请求就不带这个字段 */
  clientSecret: string
  scope: string
}

export interface OidcClientOptions {
  /** 报错文案里怎么称呼这个提供方 */
  label?: string
}

const DISCOVERY_TTL = 10 * 60 * 1000

const CLOCK_SKEW = 60 // 秒

const SUPPORTED_ALGS = /^(RS|PS|ES)(256|384|512)$/

// -------------------------------------------------------------------- PKCE

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function codeChallengeOf(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// --------------------------------------------------------------- JWT / JWKS

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

function verifySignature(alg: string, key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
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

function tokensFrom(tokens: TokenResponse, sessionState: string | null): ProviderTokens {
  const now = Date.now()
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    expiresAt: new Date(now + (tokens.expires_in ?? 60) * 1000),
    refreshExpiresAt: tokens.refresh_expires_in ? new Date(now + tokens.refresh_expires_in * 1000) : null,
    sessionState,
  }
}

export interface AuthorizeParams {
  state: string
  nonce: string
  codeChallenge: string
  /**
   * 回调地址。按访问的域名算，不是全局常量 ——
   * 每个域名的这个地址都要在提供方的 *Valid redirect URIs* 里注册。
   */
  redirectUri: string
  /** 传 'login' 强制重新输密码，'none' 静默探测登录态 */
  prompt?: 'login' | 'none' | 'consent'
}

export type OidcClient = ReturnType<typeof createOidcClient>

/** `getConfig` 每次用到时才调：调用方的配置可能晚于这个实例建好 */
export function createOidcClient(getConfig: () => OidcClientConfig, { label = 'OIDC' }: OidcClientOptions = {}) {
  let discoveryCache: { at: number; doc: Discovery } | null = null
  let discoveryInflight: Promise<Discovery> | null = null
  let jwksCache: { at: number; keys: crypto.JsonWebKey[] } | null = null

  /** 拉一次 discovery 文档并缓存 10 分钟；并发调用共享同一个请求 */
  async function discover(force = false): Promise<Discovery> {
    if (!force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL) {
      return discoveryCache.doc
    }
    discoveryInflight ??= (async () => {
      const { issuer } = getConfig()
      // 尾斜杠只影响拼路径；比较 issuer 时仍按配置原样，OIDC 要求逐字符相等
      const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
      let res: Response
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT) })
      } catch (err) {
        throw new OidcError(`连不上 ${label}（${url}）`, { retryable: true, cause: err })
      }
      if (!res.ok) throw new OidcError(`discovery 失败：${res.status} ${url}`, { retryable: true })

      const doc = (await res.json()) as Discovery
      if (doc.issuer !== issuer) {
        throw new OidcError(`issuer 不匹配：配置 ${issuer}，实际 ${doc.issuer}`)
      }
      discoveryCache = { at: Date.now(), doc }
      return doc
    })().finally(() => {
      discoveryInflight = null
    })

    return discoveryInflight
  }

  async function buildAuthorizationUrl(params: AuthorizeParams) {
    const { authorization_endpoint } = await discover()
    const { clientId, scope } = getConfig()
    const url = new URL(authorization_endpoint)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scope)
    url.searchParams.set('state', params.state)
    url.searchParams.set('nonce', params.nonce)
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (params.prompt) url.searchParams.set('prompt', params.prompt)
    return url.toString()
  }

  async function postToken(body: URLSearchParams): Promise<TokenResponse> {
    const { token_endpoint } = await discover()
    const { clientId, clientSecret } = getConfig()
    body.set('client_id', clientId)
    // confidential client 用 client_secret_post；public client 不带这个字段
    if (clientSecret) body.set('client_secret', clientSecret)

    let res: Response
    try {
      res = await fetch(token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      })
    } catch (err) {
      throw new OidcError(`连不上 ${label} 的 token 端点（${token_endpoint}）`, {
        retryable: true,
        cause: err,
      })
    }

    const payload = (await res.json().catch(() => null)) as
      | (TokenResponse & { error?: string; error_description?: string })
      | null

    if (!res.ok || !payload?.access_token) {
      const detail = payload?.error_description ?? payload?.error ?? `HTTP ${res.status}`
      // 只有提供方用 4xx 明确回绝（invalid_grant 之类）才算「这份凭证真没了」；
      // 5xx、或 2xx 但结构不对（多半半路被网关改了），都只是这一次没成功
      const rejected = !res.ok && res.status < 500
      throw new OidcError(`token 端点返回失败：${detail}`, {
        code: payload?.error,
        retryable: !rejected,
      })
    }
    return payload
  }

  /** `redirectUri` 必须和授权那一步逐字符相同，否则提供方直接回绝 */
  function exchangeCode(code: string, codeVerifier: string, redirectUri: string) {
    return postToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    )
  }

  function refreshTokens(refreshToken: string) {
    return postToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }))
  }

  /** 通知提供方作废 refresh token（对应的 SSO 会话也会结束） */
  async function revokeRefreshToken(refreshToken: string) {
    // 尽力而为：连 discovery 都拉不到就算了，本地会话该清照清，别把登出卡成 500
    let end_session_endpoint: string | undefined
    try {
      ;({ end_session_endpoint } = await discover())
    } catch {
      return
    }
    if (!end_session_endpoint) return
    const { clientId, clientSecret } = getConfig()
    const body = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken })
    if (clientSecret) body.set('client_secret', clientSecret)
    await fetch(end_session_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    }).catch(() => undefined)
  }

  /**
   * RP-initiated logout：让浏览器跳过去，把提供方上的 SSO cookie 也清掉。
   * `postLogoutUri` 用来带上「退出时人在哪」（登录页的 ?redirect=）。
   */
  async function buildLogoutUrl(idToken: string | null | undefined, postLogoutUri: string) {
    const { end_session_endpoint } = await discover()
    if (!end_session_endpoint) return postLogoutUri

    const url = new URL(end_session_endpoint)
    url.searchParams.set('post_logout_redirect_uri', postLogoutUri)
    // 带上 id_token_hint，提供方才认 post_logout_redirect_uri
    if (idToken) url.searchParams.set('id_token_hint', idToken)
    else url.searchParams.set('client_id', getConfig().clientId)
    return url.toString()
  }

  async function fetchJwks(force = false) {
    if (!force && jwksCache && Date.now() - jwksCache.at < DISCOVERY_TTL) return jwksCache.keys
    const { jwks_uri } = await discover()
    let res: Response
    try {
      res = await fetch(jwks_uri, { signal: AbortSignal.timeout(HTTP_TIMEOUT) })
    } catch (err) {
      throw new OidcError(`连不上 ${label} 的 JWKS 端点（${jwks_uri}）`, { retryable: true, cause: err })
    }
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

  /**
   * 校验 id_token：签名（JWKS）、iss、aud、exp/iat、nonce。
   * 走的是 code flow，token 是我们自己从 TLS 通道换回来的，
   * 但验一遍能顺手挡住配置串了 realm、nonce 被重放这类问题。
   */
  async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
    const { issuer, clientId } = getConfig()
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

    if (claims.iss !== issuer) throw new OidcError('id_token 的 iss 不匹配')

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(clientId)) throw new OidcError('id_token 的 aud 不含本 client')
    if (audiences.length > 1 && claims.azp && claims.azp !== clientId) {
      throw new OidcError('id_token 的 azp 不是本 client')
    }

    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now) {
      throw new OidcError('id_token 已过期')
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW > now) {
      throw new OidcError('id_token 的 iat 在未来')
    }
    if (claims.nonce !== expectedNonce) throw new OidcError('id_token 的 nonce 不匹配')
    // 身份就是 (provider, subject)：没有 sub 的 token 不能往下走，查库时 undefined 条件可能被丢掉，匹配到别人
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('id_token 没有 sub')

    return claims
  }

  /** 角色默认放在 access_token 里（Keycloak 的形状），id_token 要加 mapper 才有；claim 不存在就是空 */
  function rolesFromAccessToken(accessToken: string): string[] {
    const { clientId } = getConfig()
    const payload = decodeJwtPayload<IdTokenClaims>(accessToken)
    if (!payload) return []
    const realm = payload.realm_access?.roles ?? []
    const client = payload.resource_access?.[clientId]?.roles ?? []
    return [...new Set([...realm, ...client.map((role) => `${clientId}:${role}`)])]
  }

  return {
    discover,
    buildAuthorizationUrl,
    exchangeCode,
    refreshTokens,
    revokeRefreshToken,
    buildLogoutUrl,
    verifyIdToken,
    rolesFromAccessToken,

    /** 把浏览器送去哪儿：PKCE 的 challenge 在这里算 */
    authorizationUrl: (input: { state: string; nonce: string; codeVerifier: string; redirectUri: string }) =>
      buildAuthorizationUrl({
        state: input.state,
        nonce: input.nonce,
        redirectUri: input.redirectUri,
        codeChallenge: codeChallengeOf(input.codeVerifier),
      }),

    /** code 换 token + 验 id_token + 读身份 */
    async exchange(input: {
      code: string
      codeVerifier: string
      nonce: string
      redirectUri: string
    }): Promise<{ profile: ProviderProfile; tokens: ProviderTokens }> {
      const tokens = await exchangeCode(input.code, input.codeVerifier, input.redirectUri)
      if (!tokens.id_token) {
        throw new OidcError(`${label} 没返回 id_token，检查 client 的 scope 是否含 openid`)
      }
      const claims = await verifyIdToken(tokens.id_token, input.nonce)

      return {
        profile: {
          subject: claims.sub,
          issuer: claims.iss,
          username: claims.preferred_username ?? null,
          email: claims.email ?? null,
          name: claims.name ?? claims.preferred_username ?? null,
          avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
          roles: rolesFromAccessToken(tokens.access_token),
        },
        tokens: tokensFrom(tokens, claims.sid ?? tokens.session_state ?? null),
      }
    },

    async refresh(refreshToken: string): Promise<{ tokens: ProviderTokens; roles: string[] }> {
      const tokens = await refreshTokens(refreshToken)
      return {
        tokens: tokensFrom(tokens, tokens.session_state ?? null),
        // 角色可能在提供方被改过，刷新时一并同步
        roles: rolesFromAccessToken(tokens.access_token),
      }
    },
  }
}
