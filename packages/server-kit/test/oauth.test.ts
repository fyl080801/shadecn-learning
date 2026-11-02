import { afterEach, describe, expect, it, vi } from 'vitest'
import { OidcError, createGithubClient, createOidcClient, normalizeOrigin, pickOrigin } from '../src/oauth/index.ts'

const ALLOWED = ['https://a.example.com', 'http://b.example.com:8080']

describe('pickOrigin', () => {
  it.each([
    ['X-Forwarded-* 在名单里优先', { forwardedProto: 'https', forwardedHost: 'a.example.com', host: 'b.example.com:8080' }, 'https://a.example.com'],
    ['反代链取第一个', { forwardedProto: 'https, http', forwardedHost: 'a.example.com, x' }, 'https://a.example.com'],
    ['Host 按请求协议', { host: 'b.example.com:8080', protocol: 'http' }, 'http://b.example.com:8080'],
    ['Host 按 https 再试一次', { host: 'a.example.com', protocol: 'http' }, 'https://a.example.com'],
    ['最后才看 Origin', { host: 'internal', origin: 'https://a.example.com/' }, 'https://a.example.com'],
    ['都不在名单 → 默认，绝不跟 Host', { host: 'evil.test', forwardedHost: 'evil.test', origin: 'https://evil.test' }, 'http://fallback.test'],
    ['大小写和默认端口归一化', { forwardedProto: 'https', forwardedHost: 'A.Example.com:443' }, 'https://a.example.com'],
  ])('%s', (_name, headers, expected) => {
    expect(pickOrigin(headers, ALLOWED, 'http://fallback.test')).toBe(expected)
  })

  it('normalizeOrigin：认不出来的是 null', () => {
    expect(normalizeOrigin('ftp://a.test')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
    expect(normalizeOrigin(undefined)).toBeNull()
    expect(normalizeOrigin('HTTPS://A.test:443/x')).toBe('https://a.test')
  })
})

describe('createOidcClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  const doc = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  })

  function stubFetch(routes: Record<string, unknown>) {
    const fetchStub = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const body = routes[String(input)]
      return Promise.resolve(new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 }))
    })
    vi.stubGlobal('fetch', fetchStub)
    return fetchStub
  }

  const config = (issuer: string) => () => ({ issuer, clientId: 'c', clientSecret: '', scope: 'openid' })

  it('缓存跟着实例走：两个客户端各拉各的，互不串', async () => {
    const stub = stubFetch({
      'https://a.test/.well-known/openid-configuration': doc('https://a.test'),
      'https://b.test/.well-known/openid-configuration': doc('https://b.test'),
    })
    const a = createOidcClient(config('https://a.test'))
    const b = createOidcClient(config('https://b.test'))
    expect((await a.discover()).token_endpoint).toBe('https://a.test/token')
    expect((await b.discover()).token_endpoint).toBe('https://b.test/token')
    await a.discover()
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('配置调用时才读：实例可以早于配置建好', async () => {
    stubFetch({ 'https://late.test/.well-known/openid-configuration': doc('https://late.test') })
    let issuer = ''
    const client = createOidcClient(() => ({ issuer, clientId: 'c', clientSecret: '', scope: 'openid' }))
    issuer = 'https://late.test'
    expect((await client.discover()).issuer).toBe('https://late.test')
  })

  it('issuer 带尾斜杠：只影响拼路径，比较仍按原样', async () => {
    const stub = stubFetch({ 'https://a.test/.well-known/openid-configuration': doc('https://a.test/') })
    await expect(createOidcClient(config('https://a.test/')).discover()).resolves.toMatchObject({ issuer: 'https://a.test/' })
    expect(String(stub.mock.calls[0][0])).toBe('https://a.test/.well-known/openid-configuration')
  })

  it('每个外发请求都带超时，JWKS 也一样；连不上 JWKS 是可重试的错误', async () => {
    const stub = stubFetch({
      'https://a.test/.well-known/openid-configuration': doc('https://a.test'),
      'https://a.test/jwks': { keys: [] },
    })
    const client = createOidcClient(config('https://a.test'))
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url')
    await expect(client.verifyIdToken(`${header}.e30.c2ln`, 'n')).rejects.toThrow('JWKS 里找不到')
    for (const [, init] of stub.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal)

    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) =>
      String(input).endsWith('/jwks')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(new Response(JSON.stringify(doc('https://a.test')))),
    ))
    const fresh = createOidcClient(config('https://a.test'))
    await expect(fresh.verifyIdToken(`${header}.e30.c2ln`, 'n')).rejects.toMatchObject({ name: 'OidcError', retryable: true })
  })

  it('claim 不存在时角色是空的', () => {
    const client = createOidcClient(config('https://a.test'))
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(client.rolesFromAccessToken(`h.${encode({ sub: 'x' })}.s`)).toEqual([])
    expect(client.rolesFromAccessToken('not-a-jwt')).toEqual([])
    expect(
      client.rolesFromAccessToken(`h.${encode({ realm_access: { roles: ['a'] }, resource_access: { c: { roles: ['b'] }, other: { roles: ['x'] } } })}.s`),
    ).toEqual(['a', 'c:b'])
  })
})

describe('createGithubClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  const client = createGithubClient(() => ({ clientId: 'g', clientSecret: 's', scope: 'read:user' }))

  it('授权地址：不带 PKCE，带上 allow_signup=false', () => {
    const url = new URL(client.authorizationUrl({ state: 'st', redirectUri: 'https://a.test/cb' }))
    expect(url.origin).toBe('https://github.com')
    expect(url.searchParams.get('code_challenge')).toBeNull()
    expect(url.searchParams.get('allow_signup')).toBe('false')
  })

  it('token 端点 200 + error：不可重试的 OidcError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }))))
    const failure = client.exchange({ code: 'x', redirectUri: 'https://a.test/cb' })
    await expect(failure).rejects.toBeInstanceOf(OidcError)
    await expect(failure).rejects.toMatchObject({ code: 'bad_verification_code', retryable: false })
  })

  it('/user 没有 id：拒绝，不能用 undefined 当身份', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) =>
      Promise.resolve(new Response(JSON.stringify(String(input).includes('access_token') ? { access_token: 't' } : { login: 'x' }))),
    ))
    await expect(client.exchange({ code: 'x', redirectUri: 'https://a.test/cb' })).rejects.toThrow('没有 id')
  })
})
