import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ID,
  DISCOVERY_URL,
  END_SESSION_ENDPOINT,
  ISSUER,
  JWKS_URI,
  REDIRECT_URI,
  TOKEN_ENDPOINT,
  accessTokenWith,
  discoveryDoc,
  idTokenClaims,
  jwksDoc,
  signJwt,
  stubOidcFetch,
  tokenResponse,
  unsignedJwt,
} from '../helpers/oidc.ts'

/**
 * discovery / JWKS 都有 10 分钟的模块级缓存，每个用例重新 import 一次
 * 才能从干净状态开始。
 */
async function loadOidc() {
  vi.resetModules()
  return import('../../auth/oidc.ts')
}

let stub: ReturnType<typeof stubOidcFetch>

beforeEach(() => {
  stub = stubOidcFetch()
})

describe('discover()', () => {
  it('拉 {issuer}/.well-known/openid-configuration，端点不写死', async () => {
    const { discover } = await loadOidc()
    const doc = await discover()

    expect(stub.calls[0]?.url).toBe(DISCOVERY_URL)
    expect(doc.token_endpoint).toBe(TOKEN_ENDPOINT)
    expect(doc.jwks_uri).toBe(JWKS_URI)
  })

  it('缓存 10 分钟，重复调用只发一次请求', async () => {
    const { discover } = await loadOidc()
    await discover()
    await discover()
    await discover()

    expect(stub.calls.filter((c) => c.url === DISCOVERY_URL)).toHaveLength(1)
  })

  it('并发调用共享同一个在途请求', async () => {
    const { discover } = await loadOidc()
    await Promise.all([discover(), discover(), discover()])

    expect(stub.calls.filter((c) => c.url === DISCOVERY_URL)).toHaveLength(1)
  })

  it('force=true 会绕过缓存重新拉', async () => {
    const { discover } = await loadOidc()
    await discover()
    await discover(true)

    expect(stub.calls.filter((c) => c.url === DISCOVERY_URL)).toHaveLength(2)
  })

  it('文档里的 issuer 和配置对不上就报错（挡住 realm 配串）', async () => {
    stub.discovery = { status: 200, body: { ...discoveryDoc, issuer: `${ISSUER}-other` } }
    const { discover, OidcError } = await loadOidc()

    await expect(discover()).rejects.toBeInstanceOf(OidcError)
    await expect(discover()).rejects.toThrowError(/issuer 不匹配/)
  })

  it('HTTP 状态码不对报 discovery 失败', async () => {
    stub.discovery = { status: 404, body: { error: 'not found' } }
    const { discover } = await loadOidc()
    await expect(discover()).rejects.toThrowError(/discovery 失败：404/)
  })

  it('连不上时报「连不上 Keycloak」而不是裸的网络错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    )
    const { discover } = await loadOidc()
    await expect(discover()).rejects.toThrowError(/连不上 Keycloak/)
  })

  it('失败之后不会把坏结果缓存起来', async () => {
    stub.discovery = { status: 500, body: null }
    const { discover } = await loadOidc()
    await expect(discover()).rejects.toThrow()

    stub.discovery = { status: 200, body: discoveryDoc }
    await expect(discover()).resolves.toMatchObject({ issuer: ISSUER })
  })
})

describe('PKCE', () => {
  it('randomToken 默认 32 字节，base64url 编码，不重复', async () => {
    const { randomToken } = await loadOidc()
    const token = randomToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50)
  })

  it('randomToken 支持指定长度', async () => {
    const { randomToken } = await loadOidc()
    expect(Buffer.from(randomToken(64), 'base64url')).toHaveLength(64)
  })

  it('codeChallengeOf 就是 S256(verifier) 的 base64url', async () => {
    const { codeChallengeOf } = await loadOidc()
    // RFC 7636 附录 B 的官方向量
    expect(codeChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('同一个 verifier 每次算出来一样，不同 verifier 不一样', async () => {
    const { codeChallengeOf } = await loadOidc()
    expect(codeChallengeOf('abc')).toBe(codeChallengeOf('abc'))
    expect(codeChallengeOf('abc')).not.toBe(codeChallengeOf('abd'))
  })
})

describe('buildAuthorizationUrl()', () => {
  it('带齐 code flow + PKCE 需要的参数', async () => {
    const { buildAuthorizationUrl } = await loadOidc()
    const url = new URL(
      await buildAuthorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'cc' }),
    )

    expect(url.origin + url.pathname).toBe(discoveryDoc.authorization_endpoint)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile email',
      state: 's',
      nonce: 'n',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
    })
  })

  it('prompt 只有传了才出现在地址里', async () => {
    const { buildAuthorizationUrl } = await loadOidc()
    const base = { state: 's', nonce: 'n', codeChallenge: 'cc' } as const

    expect(new URL(await buildAuthorizationUrl(base)).searchParams.has('prompt')).toBe(false)
    expect(
      new URL(await buildAuthorizationUrl({ ...base, prompt: 'login' })).searchParams.get('prompt'),
    ).toBe('login')
  })
})

describe('exchangeCode() / refreshTokens()', () => {
  it('用 authorization_code + code_verifier 换 token', async () => {
    const { exchangeCode } = await loadOidc()
    await exchangeCode('the-code', 'the-verifier')

    const call = stub.calls.find((c) => c.url === TOKEN_ENDPOINT)
    const body = new URLSearchParams(call?.body ?? '')
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: 'the-verifier',
      client_id: CLIENT_ID,
    })
  })

  it('public client（没 secret）不带 client_secret 字段', async () => {
    const { exchangeCode } = await loadOidc()
    await exchangeCode('c', 'v')

    const body = new URLSearchParams(stub.calls.find((c) => c.url === TOKEN_ENDPOINT)?.body ?? '')
    expect(body.has('client_secret')).toBe(false)
  })

  it('配了 secret 就用 client_secret_post', async () => {
    vi.stubEnv('KEYCLOAK_CLIENT_SECRET', 's3cret')
    const { exchangeCode } = await loadOidc()
    await exchangeCode('c', 'v')

    const body = new URLSearchParams(stub.calls.find((c) => c.url === TOKEN_ENDPOINT)?.body ?? '')
    expect(body.get('client_secret')).toBe('s3cret')
  })

  it('refreshTokens 用 refresh_token 授权类型', async () => {
    const { refreshTokens } = await loadOidc()
    await refreshTokens('rt-1')

    const body = new URLSearchParams(stub.calls.find((c) => c.url === TOKEN_ENDPOINT)?.body ?? '')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-1')
  })

  it('token 端点返回错误时把 error_description 带出来', async () => {
    stub.token = {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Code not valid' },
    }
    const { exchangeCode, OidcError } = await loadOidc()

    await expect(exchangeCode('c', 'v')).rejects.toBeInstanceOf(OidcError)
    await expect(exchangeCode('c', 'v')).rejects.toThrowError(/Code not valid/)
  })

  it('200 但没有 access_token 也算失败', async () => {
    stub.token = { status: 200, body: { token_type: 'Bearer' } }
    const { exchangeCode } = await loadOidc()
    await expect(exchangeCode('c', 'v')).rejects.toThrowError(/token 端点返回失败/)
  })
})

describe('verifyIdToken()', () => {
  it('签名/iss/aud/exp/nonce 都对就返回 claims', async () => {
    const { verifyIdToken } = await loadOidc()
    const claims = await verifyIdToken(signJwt(idTokenClaims()), 'nonce-1')

    expect(claims).toMatchObject({ iss: ISSUER, sub: 'user-1', preferred_username: 'alice' })
  })

  it('aud 是数组时只要包含本 client 就行', async () => {
    const { verifyIdToken } = await loadOidc()
    const token = signJwt(idTokenClaims({ aud: ['account', CLIENT_ID], azp: CLIENT_ID }))
    await expect(verifyIdToken(token, 'nonce-1')).resolves.toMatchObject({ sub: 'user-1' })
  })

  it.each([
    ['格式不是三段', 'not.a.jwt.at.all', /格式不对/],
    ['算法不支持', signJwt(idTokenClaims(), { alg: 'HS256' }), /不支持的 id_token 算法/],
  ])('%s → 报错', async (_label, token, pattern) => {
    const { verifyIdToken } = await loadOidc()
    await expect(verifyIdToken(token, 'nonce-1')).rejects.toThrowError(pattern)
  })

  it('签名被改过就拒绝', async () => {
    const { verifyIdToken } = await loadOidc()
    await expect(verifyIdToken(unsignedJwt(idTokenClaims()), 'nonce-1')).rejects.toThrowError(
      /签名校验失败/,
    )
  })

  it('换了另一把私钥签的也拒绝', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString(
      'base64url',
    )
    const payload = Buffer.from(JSON.stringify(idTokenClaims())).toString('base64url')
    const sig = crypto
      .sign('sha256', Buffer.from(`${header}.${payload}`), other.privateKey)
      .toString('base64url')

    const { verifyIdToken } = await loadOidc()
    await expect(verifyIdToken(`${header}.${payload}.${sig}`, 'nonce-1')).rejects.toThrowError(
      /签名校验失败/,
    )
  })

  it.each([
    ['iss 不是配置的那个 realm', { iss: 'https://evil.test/realms/x' }, /iss 不匹配/],
    ['aud 不含本 client', { aud: 'someone-else' }, /aud 不含本 client/],
    ['已经过期（超出 60s 容差）', { exp: Math.floor(Date.now() / 1000) - 120 }, /已过期/],
    ['iat 在未来', { iat: Math.floor(Date.now() / 1000) + 600 }, /iat 在未来/],
  ])('%s → 拒绝', async (_label, overrides, pattern) => {
    const { verifyIdToken } = await loadOidc()
    await expect(verifyIdToken(signJwt(idTokenClaims(overrides)), 'nonce-1')).rejects.toThrowError(
      pattern,
    )
  })

  it('azp 不是本 client（且 aud 有多个）就拒绝', async () => {
    const { verifyIdToken } = await loadOidc()
    const token = signJwt(idTokenClaims({ aud: [CLIENT_ID, 'account'], azp: 'other-client' }))
    await expect(verifyIdToken(token, 'nonce-1')).rejects.toThrowError(/azp 不是本 client/)
  })

  it('nonce 对不上就拒绝（挡重放）', async () => {
    const { verifyIdToken } = await loadOidc()
    await expect(
      verifyIdToken(signJwt(idTokenClaims({ nonce: 'nonce-1' })), 'nonce-2'),
    ).rejects.toThrowError(/nonce 不匹配/)
  })

  it('刚好在 60s 容差内的过期时间还认', async () => {
    const { verifyIdToken } = await loadOidc()
    const token = signJwt(idTokenClaims({ exp: Math.floor(Date.now() / 1000) - 10 }))
    await expect(verifyIdToken(token, 'nonce-1')).resolves.toMatchObject({ sub: 'user-1' })
  })

  it('kid 找不到时重新拉一次 JWKS（密钥轮换）', async () => {
    stub.jwks = { status: 200, body: { keys: [] } }
    const { verifyIdToken } = await loadOidc()

    const firstAttempt = verifyIdToken(signJwt(idTokenClaims()), 'nonce-1')
    await expect(firstAttempt).rejects.toThrowError(/找不到 kid/)
    // 缓存一次 + 强制刷新一次 = 两次 JWKS 请求
    expect(stub.calls.filter((c) => c.url === JWKS_URI)).toHaveLength(2)
  })

  it('JWKS 拉不下来时报明确的错', async () => {
    stub.jwks = { status: 503, body: null }
    const { verifyIdToken } = await loadOidc()
    await expect(verifyIdToken(signJwt(idTokenClaims()), 'nonce-1')).rejects.toThrowError(
      /JWKS 拉取失败：503/,
    )
  })
})

describe('rolesFromAccessToken()', () => {
  it('realm 角色原样保留，client 角色加 clientId: 前缀', async () => {
    const { rolesFromAccessToken } = await loadOidc()
    const token = accessTokenWith({ realm: ['user'], client: ['admin'] })

    expect(rolesFromAccessToken(token)).toEqual(['user', `${CLIENT_ID}:admin`])
  })

  it('去重', async () => {
    const { rolesFromAccessToken } = await loadOidc()
    const token = signJwt({ realm_access: { roles: ['a', 'a', 'b'] } })
    expect(rolesFromAccessToken(token)).toEqual(['a', 'b'])
  })

  it('只取本 client 的 resource_access，别人的不要', async () => {
    const { rolesFromAccessToken } = await loadOidc()
    const token = signJwt({
      resource_access: {
        [CLIENT_ID]: { roles: ['mine'] },
        'other-client': { roles: ['theirs'] },
      },
    })
    expect(rolesFromAccessToken(token)).toEqual([`${CLIENT_ID}:mine`])
  })

  it.each([
    ['没有角色字段', signJwt({ sub: 'x' })],
    ['不是 JWT', 'garbage'],
    ['空字符串', ''],
  ])('%s → 空数组，不抛异常', async (_label, token) => {
    const { rolesFromAccessToken } = await loadOidc()
    expect(rolesFromAccessToken(token)).toEqual([])
  })
})

describe('decodeJwtPayload()', () => {
  it('解出 payload', async () => {
    const { decodeJwtPayload } = await loadOidc()
    expect(decodeJwtPayload(signJwt({ hello: 'world' }))).toEqual({ hello: 'world' })
  })

  it.each([['两段', 'a.b'], ['payload 不是 JSON', 'a.!!!.c'], ['空串', '']])(
    '%s → null',
    async (_label, token) => {
      const { decodeJwtPayload } = await loadOidc()
      expect(decodeJwtPayload(token)).toBeNull()
    },
  )
})

describe('buildLogoutUrl() / revokeRefreshToken()', () => {
  it('带 id_token_hint 时用它，Keycloak 才认 post_logout_redirect_uri', async () => {
    const { buildLogoutUrl } = await loadOidc()
    const url = new URL(await buildLogoutUrl('the-id-token'))

    expect(url.origin + url.pathname).toBe(END_SESSION_ENDPOINT)
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${'http://127.0.0.1:3000'}/login`)
    expect(url.searchParams.has('client_id')).toBe(false)
  })

  it('没有 id_token 时退而用 client_id', async () => {
    const { buildLogoutUrl } = await loadOidc()
    const url = new URL(await buildLogoutUrl(null))

    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.has('id_token_hint')).toBe(false)
  })

  it('discovery 没有 end_session_endpoint 就直接回登录页', async () => {
    const withoutLogout = { ...discoveryDoc, end_session_endpoint: undefined }
    stub.discovery = { status: 200, body: withoutLogout }
    const { buildLogoutUrl } = await loadOidc()

    await expect(buildLogoutUrl('x')).resolves.toBe('http://127.0.0.1:3000/login')
  })

  it('revokeRefreshToken POST 到 end_session 端点', async () => {
    const { revokeRefreshToken } = await loadOidc()
    await revokeRefreshToken('rt-1')

    const call = stub.calls.find((c) => c.url === END_SESSION_ENDPOINT)
    expect(new URLSearchParams(call?.body ?? '').get('refresh_token')).toBe('rt-1')
  })

  it('revokeRefreshToken 失败不抛异常（登出不该被 Keycloak 卡住）', async () => {
    const { discover, revokeRefreshToken } = await loadOidc()
    await discover()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom'))),
    )
    await expect(revokeRefreshToken('rt-1')).resolves.toBeUndefined()
  })
})

describe('helper 自检', () => {
  it('假 Keycloak 造出来的 token 能被自己验过（否则后面的用例都不算数）', async () => {
    const { verifyIdToken } = await loadOidc()
    const payload = tokenResponse({ nonce: 'n-x' })
    await expect(verifyIdToken(payload.id_token as string, 'n-x')).resolves.toMatchObject({
      iss: ISSUER,
    })
    expect(jwksDoc.keys[0]?.kid).toBe('test-kid')
  })
})
