import 'reflect-metadata'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule, User } from '@learning/data-access'
import { FakeBrowser, followAuthorize, startFakeIdp, type BrowserResponse, type FakeIdp } from '@learning/session/testing'
import { Controller, Get, Module } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRequest, Session, UserIdentity } from '../src/entities.js'
import { ApiSessionGuard, SessionModule, SessionService } from '../src/index.js'
import { LoginService } from '../src/login.service.js'
import { SessionSweeper } from '../src/session-sweeper.js'
import { sessionTokenId } from '../src/session-token.js'
import { bootContext, postgresFixture, sqliteFixture, type DatabaseFixture } from './helpers.js'

const SECRET = 'test-secret'
const OIDC_SECRET = 'oidc-secret-value'
const GITHUB_SECRET = 'github-secret-value'
const ORIGIN = 'http://app.test'
const SECURE_ORIGIN = 'https://secure.test'
const TTL_SECONDS = 3600
const HOUR = TTL_SECONDS * 1000

@Controller()
class RoutesController {
  @Get('api/private')
  secret() {
    return { secret: 'private-data' }
  }
}

const enc = encodeURIComponent

async function bootApp(values: Record<string, unknown>, env: Record<string, string | undefined> = {}, isProduction = false) {
  @Module({ controllers: [RoutesController] })
  class RoutesModule {}
  @Module({})
  class Root {}
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: Root,
      imports: [
        RoutesModule,
        testConfigModule(values, { isProduction, env: { PLATFORM_SESSION_SECRET: SECRET, ...env } }),
        DataAccessModule,
        SessionModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
    },
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  )
  await app.listen(0, '127.0.0.1')
  return { app, baseUrl: await app.getUrl() }
}

function behaviours(createFixture: () => DatabaseFixture) {
  let fixture: DatabaseFixture
  let idp: FakeIdp
  let app: NestFastifyApplication
  let baseUrl: string
  let browser: FakeBrowser
  const logs: string[] = []

  const dataAccess = () => app.get(DataAccess)
  const browserAt = (origin: string) => new FakeBrowser(baseUrl, origin)

  const sidOf = (of: FakeBrowser) => of.cookies.get('sid')?.value
  const sessionRow = (of: FakeBrowser = browser) =>
    dataAccess().em().findOne(Session, sessionTokenId(SECRET, sidOf(of) as string))
  const me = async (of: FakeBrowser = browser) =>
    JSON.parse((await of.get('/api/auth/me')).body) as { authenticated: boolean; user: Record<string, unknown> | null }

  const startLogin = (of: FakeBrowser, provider: string | null, redirect?: string, headers?: Record<string, string>) => {
    const query = [provider ? `provider=${provider}` : '', redirect ? `redirect=${enc(redirect)}` : ''].filter(Boolean).join('&')
    return of.get(`/api/auth/login?${query}`, headers)
  }
  /** 拿到提供方跳回来的地址，还没访问 */
  const authorize = async (provider: 'oidc' | 'github', of: FakeBrowser = browser, redirect?: string) => {
    const start = await startLogin(of, provider, redirect)
    expect(start.status).toBe(302)
    const location = start.headers.location as string
    return followAuthorize(provider === 'github' ? idp.githubAuthorizeUrl(location) : location)
  }
  const login = async (provider: 'oidc' | 'github', of: FakeBrowser = browser, redirect?: string) =>
    of.get(await authorize(provider, of, redirect))

  const expectRejected = async (res: BrowserResponse, message: string) => {
    expect(res.status).toBe(302)
    expect(res.headers.location).toMatch(/^\/login\?error=/)
    expect(new URLSearchParams((res.headers.location as string).split('?')[1]).get('error')).toContain(message)
    expect(browser.cookies.has('sid')).toBe(false)
    expect(await dataAccess().em().count(Session)).toBe(0)
    expect((await me()).authenticated).toBe(false)
    expect((await browser.get('/api/private')).status).toBe(401)
  }

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
    }
    idp = await startFakeIdp({ clientSecret: OIDC_SECRET })
    vi.stubGlobal('fetch', idp.fetch)
    fixture = createFixture()
    await fixture.open()
    ;({ app, baseUrl } = await bootApp(
      {
        database: { url: fixture.url },
        session: { ttlSeconds: TTL_SECONDS },
        server: { origins: [ORIGIN, SECURE_ORIGIN] },
        auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId, buttonLabel: '公司账号登录' }, github: { clientId: 'gh-client' } },
      },
      { PLATFORM_OIDC_CLIENT_SECRET: OIDC_SECRET, PLATFORM_GITHUB_CLIENT_SECRET: GITHUB_SECRET },
    ))
  })

  afterAll(async () => {
    // 整个文件跑下来的日志里，不能出现任何发出去过的 token / code，也不能出现 client secret
    const joined = logs.join('\n')
    for (const secret of [...idp.issued, OIDC_SECRET, GITHUB_SECRET]) expect(joined).not.toContain(secret)

    await app.close()
    await fixture.dispose()
    await idp.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    await fixture.clear()
    await dataAccess().em().nativeDelete(UserIdentity, {})
    browser = browserAt(ORIGIN)
    idp.user = { sub: 'alice-sub', preferred_username: 'alice', email: 'alice@example.test', name: 'Alice' }
    idp.roles = { realm: [], client: [] }
    idp.accessTokenTtl = 300
    idp.mutateClaims = null
    idp.signWithWrongKey = false
    idp.tokenOverride = null
    idp.tokenDelayMs = 0
    idp.tokenCalls.length = 0
    idp.github.tokenOverride = null
    idp.github.tokenCalls.length = 0
    idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'octo@example.test', avatar_url: 'https://avatars.test/octocat.png' }
    idp.github.emails = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('GET /api/auth/config', () => {
    it('列出配齐的登录方式，oidc 在前，按钮文字可配；不含 issuer / clientId 这些配置细节', async () => {
      const res = await browser.get('/api/auth/config')
      expect(JSON.parse(res.body)).toEqual({
        enabled: true,
        providers: [
          { id: 'oidc', label: 'OIDC', buttonLabel: '公司账号登录' },
          { id: 'github', label: 'GitHub', buttonLabel: '使用 GitHub 登录' },
        ],
      })
    })
  })

  describe('OIDC 登录', () => {
    it('完整走一遍：PKCE、redirect_uri、client_secret 都对，cookie 只有不透明的 sid，/me 已登录，/api 放行', async () => {
      const start = await startLogin(browser, 'oidc', '/projects')
      expect(start.status).toBe(302)
      expect(start.headers['set-cookie']).toEqual([expect.stringMatching(/^oidc_tx=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/)])
      const authorizeUrl = new URL(start.headers.location as string)
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${idp.issuer}/authorize`)
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)
      expect(authorizeUrl.searchParams.get('client_id')).toBe(idp.clientId)
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorizeUrl.searchParams.get('scope')).toBe('openid profile email')
      // 服务端的 verifier / nonce 原文不进浏览器能看到的地方
      const pending = await dataAccess().em().findOneOrFail(AuthRequest, { provider: 'oidc' })
      expect(start.headers.location).not.toContain(pending.codeVerifier)

      const done = await browser.get(await followAuthorize(authorizeUrl.toString()))
      expect(done.status).toBe(302)
      expect(done.headers.location).toBe('/projects')
      const cookies = done.headers['set-cookie'] as string[]
      expect(cookies).toContainEqual(expect.stringMatching(/^oidc_tx=; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=0$/))
      expect(cookies).toContainEqual(expect.stringMatching(new RegExp(`^sid=[^;]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}$`)))
      expect(browser.cookies.has('oidc_tx')).toBe(false)

      const token = idp.tokenCalls[0]
      expect(token.get('client_secret')).toBe(OIDC_SECRET)
      expect(token.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)

      const session = await me()
      expect(session.authenticated).toBe(true)
      expect(session.user).toMatchObject({ subject: 'alice-sub', username: 'alice', email: 'alice@example.test', name: 'Alice', roles: [] })
      expect(Object.keys(session.user as object).sort()).toEqual(['avatarUrl', 'email', 'id', 'name', 'roles', 'subject', 'username'])
      expect((await browser.get('/api/private')).status).toBe(200)
      expect(await dataAccess().em().count(AuthRequest)).toBe(0)
      expect((await sessionRow())?.provider).toBe('oidc')
    })

    it('不带 provider 用第一个（前端弹窗重新登录就不带）', async () => {
      const start = await startLogin(browser, null, '/x')
      expect(start.headers.location).toContain(`${idp.issuer}/authorize`)
    })

    it('realm 和客户端角色都进 User.roles，客户端角色带前缀', async () => {
      idp.roles = { realm: ['admin'], client: ['editor'] }
      await login('oidc')
      expect((await me()).user?.roles).toEqual(['admin', `${idp.clientId}:editor`])
    })

    it('已经登录：不再走一遍，直接回 redirect，仍然站内校验', async () => {
      await login('oidc')
      const calls = idp.tokenCalls.length
      expect((await startLogin(browser, 'oidc', '/y')).headers.location).toBe('/y')
      expect((await startLogin(browser, 'oidc', '//evil.com')).headers.location).toBe('/')
      expect(idp.tokenCalls.length).toBe(calls)
    })

    it.each([
      ['不存在的 provider', 'nope'],
      ['重复的 provider 参数（数组）', 'oidc&provider=github'],
    ])('%s → 回登录页说明原因，不起授权', async (_name, provider) => {
      const res = await browser.get(`/api/auth/login?provider=${provider}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toMatch(/^\/login\?error=/)
      expect(await dataAccess().em().count(AuthRequest)).toBe(0)
    })

    it('发现文档拉不到：回登录页，不留授权请求，也不写 tx cookie', async () => {
      const failing = await startFakeIdp()
      const { app: other, baseUrl: otherUrl } = await bootApp({
        database: { url: fixture.url },
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: failing.issuer, clientId: 'c' } },
      })
      await failing.stop()
      const res = await new FakeBrowser(otherUrl, ORIGIN).get('/api/auth/login')
      await other.close()
      expect(res.status).toBe(302)
      expect(res.headers.location).toMatch(/^\/login\?error=/)
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(await dataAccess().em().count(AuthRequest)).toBe(0)
    })
  })

  describe('GitHub 登录', () => {
    it('完整走一遍：无 PKCE、带 client_secret，会话到期就是 session TTL，没有 refresh token', async () => {
      const start = await startLogin(browser, 'github', '/a')
      const authorizeUrl = new URL(start.headers.location as string)
      expect(authorizeUrl.origin).toBe('https://github.com')
      expect(authorizeUrl.searchParams.get('client_id')).toBe('gh-client')
      expect(authorizeUrl.searchParams.get('code_challenge')).toBeNull()
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`)

      const done = await browser.get(await followAuthorize(idp.githubAuthorizeUrl(authorizeUrl.toString())))
      expect(done.headers.location).toBe('/a')
      expect(idp.github.tokenCalls[0].get('client_secret')).toBe(GITHUB_SECRET)

      const session = await me()
      expect(session.user).toMatchObject({ subject: '4242', username: 'octocat', name: 'Octo Cat', roles: [] })
      const row = await sessionRow()
      expect(row).toMatchObject({ provider: 'github', refreshToken: null, idToken: null })
      expect(Math.abs((row as Session).expiresAt.getTime() - Date.now() - HOUR)).toBeLessThan(10_000)
    })

    it('/user 没给邮箱：再读 /user/emails，取已验证的主邮箱', async () => {
      idp.github.user = { ...idp.github.user, email: null }
      idp.github.emails = [
        { email: 'unverified@example.test', primary: true, verified: false },
        { email: 'verified@example.test', primary: false, verified: true },
      ]
      await login('github')
      expect((await me()).user?.email).toBe('verified@example.test')
    })

    it('token 端点 200 + error body：拒绝，不建会话', async () => {
      idp.github.tokenOverride = { status: 200, body: { error: 'bad_verification_code', error_description: 'code 过期了' } }
      await expectRejected(await login('github'), 'code 过期了')
    })

    it('token 端点 200 但没有 access_token：拒绝，不建会话', async () => {
      idp.github.tokenOverride = { status: 200, body: {} }
      await expectRejected(await login('github'), 'GitHub token 端点返回异常')
    })
  })

  describe('回调拒绝', () => {
    it('state 不匹配', async () => {
      const back = await authorize('oidc')
      await expectRejected(await browser.get(back.replace(/state=[^&]+/, 'state=forged')), 'state 校验失败')
    })

    it('重放同一个回调：第二次拒绝，也不多建会话', async () => {
      const back = await authorize('oidc')
      const tx = browser.cookies.get('oidc_tx') as { value: string; path: string; secure: boolean }
      expect((await browser.get(back)).headers.location).toBe('/')
      expect(await dataAccess().em().count(Session)).toBe(1)

      const attacker = browserAt(ORIGIN)
      attacker.cookies.set('oidc_tx', tx)
      const replay = await attacker.get(back)
      expect(replay.headers.location).toMatch(/^\/login\?error=/)
      expect(attacker.cookies.has('sid')).toBe(false)
      expect(await dataAccess().em().count(Session)).toBe(1)
    })

    it('同一个回调并发两次：只有一个成功', async () => {
      const back = await authorize('oidc')
      const tx = browser.cookies.get('oidc_tx') as { value: string; path: string; secure: boolean }
      const second = browserAt(ORIGIN)
      second.cookies.set('oidc_tx', tx)
      const results = await Promise.all([browser.get(back), second.get(back)])
      expect(results.filter((res) => !String(res.headers.location).startsWith('/login')).length).toBe(1)
      expect(await dataAccess().em().count(Session)).toBe(1)
    })

    it('一次性以删除成功为准：同一个授权请求被同时消费，只有一个拿得到', async () => {
      await startLogin(browser, 'oidc')
      const { id } = await dataAccess().em().findOneOrFail(AuthRequest, { provider: 'oidc' })
      const loginService = app.get(LoginService)
      const results = await Promise.all(Array.from({ length: 4 }, () => loginService.consume(id)))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await loginService.consume(id)).toBeNull()
      expect(await loginService.consume(undefined)).toBeNull()
    })

    it('oidc_tx 缺失', async () => {
      const back = await authorize('oidc')
      browser.cookies.delete('oidc_tx')
      await expectRejected(await browser.get(back), '授权信息不完整')
    })

    it('别人的 tx cookie 配我的 state', async () => {
      const mine = await authorize('oidc')
      const other = browserAt(ORIGIN)
      await startLogin(other, 'oidc')
      browser.cookies.set('oidc_tx', other.cookies.get('oidc_tx') as { value: string; path: string; secure: boolean })
      await expectRejected(await browser.get(mine), 'state 校验失败')
    })

    it('授权请求超时', async () => {
      const back = await authorize('oidc')
      await dataAccess().em().nativeUpdate(AuthRequest, {}, { expiresAt: new Date(Date.now() - 1000) })
      await expectRejected(await browser.get(back), '登录超时')
    })

    it('提供方回 ?error=：显示原因，授权请求也消费掉', async () => {
      await startLogin(browser, 'oidc')
      await expectRejected(await browser.get('/api/auth/callback?error=access_denied&error_description=用户取消'.replace('用户取消', enc('用户取消'))), '用户取消')
      expect(await dataAccess().em().count(AuthRequest)).toBe(0)
    })

    it.each([
      ['nonce 不对', (claims: Record<string, unknown>) => ({ ...claims, nonce: 'forged' }), 'nonce'],
      ['aud 不是本 client', (claims: Record<string, unknown>) => ({ ...claims, aud: 'other-client' }), 'aud'],
      ['iss 不对', (claims: Record<string, unknown>) => ({ ...claims, iss: 'https://evil.test' }), 'iss'],
      ['已过期', (claims: Record<string, unknown>) => ({ ...claims, exp: 1000 }), '过期'],
      ['没有 sub', ({ sub: _sub, ...claims }: Record<string, unknown>) => claims, 'sub'],
    ])('id_token %s → 拒绝，不建会话', async (_name, mutate, message) => {
      idp.mutateClaims = mutate
      await expectRejected(await login('oidc'), message)
      expect(await dataAccess().em().count(User)).toBe(0)
    })

    it('id_token 的签名不对 → 拒绝，不建会话', async () => {
      idp.signWithWrongKey = true
      await expectRejected(await login('oidc'), '签名')
      expect(await dataAccess().em().count(User)).toBe(0)
    })

    it('token 端点回绝 → 拒绝；连不上时不把内网地址告诉用户', async () => {
      idp.tokenOverride = () => ({ status: 400, body: { error: 'invalid_grant', error_description: '授权码作废了' } })
      await expectRejected(await login('oidc'), '授权码作废了')

      idp.tokenOverride = () => 'drop'
      const res = await login('oidc')
      await expectRejected(res, '连不上登录服务')
      expect(decodeURIComponent(res.headers.location as string)).not.toContain(idp.issuer)
    })

    it('建会话时库报错：错误信息里的 SQL 和 token 不进 URL，也不进日志', async () => {
      const spy = vi.spyOn(app.get(SessionService), 'create').mockRejectedValueOnce(new Error('insert into session values (leaked-token-value)'))
      const res = await login('oidc')
      spy.mockRestore()
      await expectRejected(res, '登录失败，请重试')
      expect(res.headers.location).not.toContain('leaked')
      expect(logs.join('\n')).not.toContain('leaked-token-value')
    })

    it('失败回登录页时带着 redirect，重试之后还能回到原处', async () => {
      const back = await authorize('oidc', browser, '/projects')
      const res = await browser.get(back.replace(/state=[^&]+/, 'state=forged'))
      expect(new URLSearchParams((res.headers.location as string).split('?')[1]).get('redirect')).toBe('/projects')
    })
  })

  describe('回调的域名白名单', () => {
    const redirectUriOf = (res: BrowserResponse) => new URL(res.headers.location as string).searchParams.get('redirect_uri')

    it.each([
      ['Host 不在白名单', { host: 'evil.test' }, ORIGIN],
      ['X-Forwarded-Host 不在白名单，Host 在', { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' }, ORIGIN],
      ['全都不在白名单', { host: 'evil.test', 'x-forwarded-host': 'evil.test', origin: 'https://evil.test' }, ORIGIN],
      ['X-Forwarded-* 在白名单', { host: 'internal.svc', 'x-forwarded-host': 'secure.test', 'x-forwarded-proto': 'https' }, SECURE_ORIGIN],
      ['反代没给 X-Forwarded-Proto：Host 按 https 再试一次', { host: 'secure.test' }, SECURE_ORIGIN],
      ['Host 是内网名字，靠 Origin 认出对外域名', { host: 'internal.svc', origin: SECURE_ORIGIN }, SECURE_ORIGIN],
    ])('%s', async (_name, headers, origin) => {
      const res = await startLogin(browser, 'oidc', undefined, headers)
      expect(redirectUriOf(res)).toBe(`${origin}/api/auth/callback`)
    })

    it('https 的 origin：tx 和会话 cookie 都带 Secure；没开 trustProxy 也一样', async () => {
      const secure = browserAt(SECURE_ORIGIN)
      const start = await secure.get('/api/auth/login?provider=oidc', { 'x-forwarded-proto': 'https' })
      expect(start.headers['set-cookie']?.[0]).toMatch(/; Secure$/)
      const done = await secure.get(await followAuthorize(start.headers.location as string))
      expect(done.headers['set-cookie']).toContainEqual(expect.stringMatching(/^sid=[^;]+;.*; Secure$/))
      expect((await me(secure)).authenticated).toBe(true)

      const logout = await secure.get('/api/auth/logout')
      expect(logout.headers['set-cookie']).toEqual(['sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'])
    })

    it('redirect_uri 用存下来的 origin，回调这一趟的 Host 变了也不重算', async () => {
      const secure = browserAt(SECURE_ORIGIN)
      const back = await authorize('oidc', secure)
      const done = await secure.get(back, { host: 'evil.test' })
      expect(done.headers.location).toBe('/')
      expect(idp.tokenCalls.at(-1)?.get('redirect_uri')).toBe(`${SECURE_ORIGIN}/api/auth/callback`)
    })
  })

  describe('登录后的回跳', () => {
    it.each(['//evil.com', '/\\evil.com', 'https://evil.com', '/\t/evil.com'])('redirect=%j → 回到 /', async (redirect) => {
      expect((await login('oidc', browser, redirect)).headers.location).toBe('/')
    })

    it('非 ASCII 的路径转义后写进 Location，不是 500', async () => {
      const res = await login('oidc', browser, '/项目/1')
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(`/${enc('项目')}/1`)
    })
  })

  describe('登录窗口的终点站', () => {
    it.each(['oidc', 'github'] as const)('%s：redirect=/auth/login-done 落到 /api 下的那张页面，通知开它的窗口', async (provider) => {
      const done = await login(provider, browser, '/auth/login-done')
      expect(done.headers.location).toBe('/api/auth/login-done')
      expect(done.headers['set-cookie']).toContainEqual(expect.stringMatching(/^sid=/))

      const page = await browser.get(done.headers.location as string)
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.headers['cache-control']).toBe('no-store')
      expect(page.body).toContain('app-auth:login-done')
      expect(page.body).toContain('window.opener.postMessage')
    })

    it('窗口打开时已经登录：直接到那张页面', async () => {
      await login('oidc')
      expect((await browser.get(`/api/auth/login?redirect=${enc('/auth/login-done')}`)).headers.location).toBe('/api/auth/login-done')
    })

    it('页面匿名也打得开：它不带任何用户信息，通知之后前端会自己问 /me', async () => {
      expect((await browser.get('/api/auth/login-done')).status).toBe(200)
    })
  })

  describe('身份只认 (provider, subject)', () => {
    it('同一个人第二次登录：不新建用户，档案按主身份刷新', async () => {
      await login('oidc')
      const firstId = (await me()).user?.id

      idp.user = { ...idp.user, name: 'Alice 改名了' }
      const again = browserAt(ORIGIN)
      await login('oidc', again)
      const session = await me(again)
      expect(session.user?.id).toBe(firstId)
      expect(session.user?.name).toBe('Alice 改名了')
      expect(await dataAccess().em().count(User)).toBe(1)
      expect(await dataAccess().em().count(UserIdentity)).toBe(1)
    })

    it('同 email 不同 provider：两个账号，不合并', async () => {
      idp.github.user = { ...idp.github.user, email: 'alice@example.test' }
      await login('oidc')
      const other = browserAt(ORIGIN)
      await login('github', other)
      expect((await me()).user?.id).not.toBe((await me(other)).user?.id)
      expect(await dataAccess().em().count(User)).toBe(2)
    })

    it('同 email 同 provider 不同 subject：两个账号', async () => {
      await login('oidc')
      idp.user = { ...idp.user, sub: 'mallory-sub' }
      const other = browserAt(ORIGIN)
      await login('oidc', other)
      expect((await me()).user?.id).not.toBe((await me(other)).user?.id)
    })

    it('GitHub 登录不写 roles：不会清掉数据库里已有的角色', async () => {
      await login('github')
      const row = await dataAccess().em().findOneOrFail(User, { subject: '4242' })
      await dataAccess().em().nativeUpdate(User, { id: row.id }, { roles: '["admin"]' })
      const again = browserAt(ORIGIN)
      await login('github', again)
      expect((await me(again)).user?.roles).toEqual(['admin'])
    })

    it('两个回调同时建同一个新用户：都成功，只有一个用户', async () => {
      const other = browserAt(ORIGIN)
      const [a, b] = await Promise.all([authorize('oidc'), authorize('oidc', other)])
      await Promise.all([browser.get(a), other.get(b)])
      expect((await me()).authenticated).toBe(true)
      expect((await me(other)).authenticated).toBe(true)
      expect(await dataAccess().em().count(User)).toBe(1)
    })
  })

  describe('token 不到浏览器', () => {
    it.each(['oidc', 'github'] as const)('%s：登录全程和 /me 的响应（头和体）里都没有提供方发的任何东西', async (provider) => {
      const responses: BrowserResponse[] = []
      const start = await startLogin(browser, provider)
      responses.push(start)
      const location = start.headers.location as string
      const back = await followAuthorize(provider === 'github' ? idp.githubAuthorizeUrl(location) : location)
      responses.push(await browser.get(back))
      responses.push(await browser.get('/api/auth/me'))
      responses.push(await browser.get('/api/private'))

      const code = new URLSearchParams(back.split('?')[1]).get('code') as string
      expect(idp.issued).toContain(code)
      const seen = JSON.stringify(responses)
      for (const secret of [...idp.issued, OIDC_SECRET, GITHUB_SECRET]) expect(seen).not.toContain(secret)
    })
  })

  describe('续期', () => {
    /** 登录时 access_token 只剩 10 秒，下一个请求就落在 30 秒窗口里 */
    const loginExpiring = async () => {
      idp.accessTokenTtl = 10
      await login('oidc')
      idp.accessTokenTtl = 300
      idp.tokenCalls.length = 0
    }
    const refreshCalls = () => idp.tokenCalls.filter((params) => params.get('grant_type') === 'refresh_token').length
    const refreshTokenOf = async () => (await sessionRow())?.refreshToken

    it('临期成功刷新：换掉 access / refresh，到期后移，角色同步，cookie 不变', async () => {
      await loginExpiring()
      const before = await sessionRow()
      const sid = sidOf(browser)
      idp.roles = { realm: ['ops'], client: [] }

      const session = await me()

      expect(session.authenticated).toBe(true)
      expect(session.user?.roles).toEqual(['ops'])
      expect(refreshCalls()).toBe(1)
      expect(idp.tokenCalls[0].get('refresh_token')).toBe(before?.refreshToken)
      expect(idp.tokenCalls[0].get('client_secret')).toBe(OIDC_SECRET)
      const after = await sessionRow()
      expect(after?.accessToken).not.toBe(before?.accessToken)
      expect(after?.refreshToken).not.toBe(before?.refreshToken)
      expect((after as Session).expiresAt.getTime()).toBeGreaterThan(Date.now() + 200_000)
      expect(sidOf(browser)).toBe(sid)

      await me()
      expect(refreshCalls()).toBe(1)
    })

    it('access_token 已经过期也能续回来：不是到点就踢人', async () => {
      await loginExpiring()
      await dataAccess().em().nativeUpdate(Session, {}, { expiresAt: new Date(Date.now() - 60_000) })
      expect((await me()).authenticated).toBe(true)
      expect((await browser.get('/api/private')).status).toBe(200)
    })

    it('并发只刷一次，全部成功：轮换的 refresh token 不会把会话注销', async () => {
      await loginExpiring()
      idp.tokenDelayMs = 100
      // 第二次拿旧 refresh token 就回绝，和开了轮换的真实提供方一样
      const used = new Set<string>()
      idp.tokenOverride = (params) => {
        const token = params.get('refresh_token') as string
        if (used.has(token)) return { status: 400, body: { error: 'invalid_grant' } }
        used.add(token)
        return null
      }

      const results = await Promise.all(Array.from({ length: 8 }, () => browser.get('/api/private')))

      expect(results.map((res) => res.status)).toEqual(Array(8).fill(200))
      expect(refreshCalls()).toBe(1)
      expect((await me()).authenticated).toBe(true)
    })

    it('同一拍进来的请求都读到了旧行：还是只刷一次', async () => {
      await loginExpiring()
      idp.tokenDelayMs = 50
      const sessions = app.get(SessionService)
      const sid = sidOf(browser) as string
      const results = await Promise.all(Array.from({ length: 6 }, () => sessions.load(sid)))
      expect(results.every(Boolean)).toBe(true)
      expect(refreshCalls()).toBe(1)
    })

    it('读到旧行的请求抢到续期时重新读库：刚续过就不再拿旧 refresh token 去换', async () => {
      await loginExpiring()
      const sessions = app.get(SessionService) as unknown as { find(id: string): Promise<unknown>; load: SessionService['load'] }
      const sid = sidOf(browser) as string
      const stale = await sessions.find(sessionTokenId(SECRET, sid))
      expect((await sessions.load(sid))?.refreshToken).not.toBeNull()
      expect(refreshCalls()).toBe(1)

      // 这个请求的第一次读发生在上面那次续期落库之前
      const find = vi.spyOn(sessions, 'find').mockResolvedValueOnce(stale)
      expect(await sessions.load(sid)).not.toBeNull()
      find.mockRestore()
      expect(refreshCalls()).toBe(1)
    })

    it('invalid_grant：删会话，/me 未登录并清 cookie，/api 401', async () => {
      await loginExpiring()
      const row = await sessionRow()
      idp.tokenOverride = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Session not active' } })

      const res = await browser.get('/api/auth/me')

      expect(JSON.parse(res.body)).toMatchObject({ authenticated: false, user: null })
      expect(res.headers['set-cookie']).toEqual(['sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
      expect(await dataAccess().em().findOne(Session, (row as Session).id)).toBeNull()
      expect((await browser.get('/api/private')).status).toBe(401)
    })

    it.each([
      ['500', () => ({ status: 500, body: { error: 'server_error' } })],
      ['连接中断', () => 'drop' as const],
      ['2xx 但结构不对', () => ({ status: 200, body: { nope: true } })],
    ])('%s：保留会话，15 秒冷却内不再撞，冷却后再试并恢复', async (_name, failure) => {
      await loginExpiring()
      const refreshBefore = await refreshTokenOf()
      idp.tokenOverride = failure

      expect((await me()).authenticated).toBe(true)
      expect(refreshCalls()).toBe(1)
      expect((await browser.get('/api/private')).status).toBe(200)
      expect((await me()).authenticated).toBe(true)
      expect(refreshCalls()).toBe(1)
      expect(await refreshTokenOf()).toBe(refreshBefore)

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16_000 })
      idp.tokenOverride = null
      expect((await me()).authenticated).toBe(true)
      expect(refreshCalls()).toBe(2)
      expect(await refreshTokenOf()).not.toBe(refreshBefore)
    })

    it('本地写库失败：保留会话，冷却后再试', async () => {
      await loginExpiring()
      const data = dataAccess()
      const spy = vi.spyOn(data, 'transactional').mockRejectedValueOnce(new Error('database is locked'))
      expect((await me()).authenticated).toBe(true)
      expect(refreshCalls()).toBe(1)
      spy.mockRestore()
      expect((await sessionRow())).not.toBeNull()
    })

    it('refresh token 也过期了：删会话', async () => {
      await loginExpiring()
      await dataAccess().em().nativeUpdate(Session, {}, { refreshExpiresAt: new Date(Date.now() - 1000) })
      expect((await me()).authenticated).toBe(false)
      expect(refreshCalls()).toBe(0)
      expect(await dataAccess().em().count(Session)).toBe(0)
    })

    it('活过 session TTL：不管 refresh token 还在不在，都删', async () => {
      await login('oidc')
      await dataAccess().em().nativeUpdate(Session, {}, { createdAt: new Date(Date.now() - 2 * HOUR) })
      expect((await me()).authenticated).toBe(false)
      expect(await dataAccess().em().count(Session)).toBe(0)
    })

    it('GitHub：没有 refresh，不发刷新请求，由 session TTL 结束', async () => {
      await login('github')
      expect((await me()).authenticated).toBe(true)
      expect(refreshCalls()).toBe(0)
      await dataAccess().em().nativeUpdate(Session, {}, { createdAt: new Date(Date.now() - 2 * HOUR) })
      expect((await me()).authenticated).toBe(false)
    })

    it('登出：删会话、清 cookie，之后 /api 401', async () => {
      await login('oidc')
      const res = await browser.get('/api/auth/logout')
      expect(res.headers.location).toBe('/login')
      expect(await dataAccess().em().count(Session)).toBe(0)
      expect((await browser.get('/api/private')).status).toBe(401)
    })

    it('会话对应的提供方后来撤了配置：到期时走不了续期，删', async () => {
      await login('oidc')
      await dataAccess().em().nativeUpdate(Session, {}, { provider: 'removed', expiresAt: new Date(Date.now() - 1000) })
      expect((await me()).authenticated).toBe(false)
    })
  })
}

describe('登录流程（SQLite）', () => {
  behaviours(sqliteFixture)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('登录流程（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(() => postgresFixture(postgresUrl as string))
})

describe('登录配置', () => {
  let fixture: DatabaseFixture

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    fixture = sqliteFixture()
    await fixture.open()
  })
  afterEach(async () => {
    await fixture.dispose()
    vi.restoreAllMocks()
  })

  const boot = (
    values: Record<string, unknown>,
    env: Record<string, string | undefined> = {},
    isProduction = false,
  ) =>
    bootContext([
      testConfigModule(
        { database: { url: fixture.url }, ...values },
        { isProduction, env: { PLATFORM_SESSION_SECRET: SECRET, ...env } },
      ),
      DataAccessModule,
      SessionModule,
    ])

  const OIDC = { issuer: 'https://idp.test/realms/x', clientId: 'c' }

  it.each([
    ['oidc 只有 issuer', { oidc: { issuer: OIDC.issuer } }, {}, 'auth.oidc.clientId'],
    ['oidc 只有 clientId', { oidc: { clientId: 'c' } }, {}, 'auth.oidc.issuer'],
    ['oidc 只写了按钮文字', { oidc: { buttonLabel: 'x' } }, {}, 'auth.oidc.issuer'],
    ['oidc 只有 .env 的密钥', {}, { PLATFORM_OIDC_CLIENT_SECRET: 's' }, 'auth.oidc.clientId'],
    ['github 只有 clientId', { github: { clientId: 'g' } }, {}, 'PLATFORM_GITHUB_CLIENT_SECRET'],
    ['github 只有 .env 的密钥', {}, { PLATFORM_GITHUB_CLIENT_SECRET: 's' }, 'auth.github.clientId'],
  ])('半套配置（%s）→ 启动失败，报缺什么', async (_name, auth, env, missing) => {
    await expect(boot({ auth }, env)).rejects.toThrow(missing)
  })

  it.each([
    ['auth.oidc.clientSecret', { oidc: { ...OIDC, clientSecret: 'hunter2' } }],
    ['auth.github.clientSecret', { github: { clientId: 'g', clientSecret: 'hunter2' } }],
    ['auth.github.client_secret', { github: { clientId: 'g', client_secret: 'hunter2' } }],
    ['auth.oidc.secret', { oidc: { ...OIDC, secret: '' } }],
  ])('yaml 里写了密钥（%s）→ 启动失败，不带值', async (field, auth) => {
    const failure = boot({ auth })
    await expect(failure).rejects.toThrow(`密钥不能写在 config.yaml 的 ${field}`)
    await expect(failure).rejects.not.toThrow('hunter2')
  })

  it.each([
    ['auth.oidc 不是映射', { auth: { oidc: 'x' } }, 'auth.oidc 必须是映射'],
    ['clientId 不是字符串', { auth: { oidc: { issuer: OIDC.issuer, clientId: 1 } } }, 'auth.oidc.clientId 必须是字符串'],
    ['issuer 不是地址', { auth: { oidc: { issuer: 'idp.test', clientId: 'c' } } }, 'auth.oidc.issuer'],
    ['origins 不是列表', { server: { origins: 'http://a.test' } }, 'server.origins 必须是列表'],
    ['origins 带路径', { server: { origins: ['http://a.test/api/auth/callback'] } }, '不是合法的 origin'],
    ['origins 不是 http(s)', { server: { origins: ['ftp://a.test'] } }, '不是合法的 origin'],
    ['origins 带通配符', { server: { origins: ['https://*.a.test'] } }, '不是合法的 origin'],
    ['origins 项不是字符串', { server: { origins: [1] } }, '不是合法的 origin'],
    ['端口 0 又没有 origins', { server: { port: 0 }, auth: { oidc: OIDC } }, 'server.origins'],
  ])('错配（%s）→ 启动失败', async (_name, values, message) => {
    await expect(boot(values)).rejects.toThrow(message)
  })

  it('生产配了 provider 却没有 origins → 启动失败', async () => {
    await expect(boot({ auth: { oidc: OIDC } }, {}, true)).rejects.toThrow('server.origins')
    await expect(boot({ auth: { github: { clientId: 'g' } } }, { PLATFORM_GITHUB_CLIENT_SECRET: 's' }, true)).rejects.toThrow('server.origins')
  })

  it('生产配了 provider 和 origins → 能起；没配 provider 不要求 origins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await (await boot({ auth: { oidc: OIDC }, server: { origins: ['https://a.test'] } }, {}, true)).close()
    expect(warn).not.toHaveBeenCalled()
    await (await boot({}, {}, true)).close()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没有配置登录方式'))
  })

  it('写成单数的 server.origin：不生效，警告一条', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await (await boot({ server: { origin: 'http://a.test' }, auth: { oidc: OIDC } })).close()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('server.origin 不会被读取'))
    await expect(boot({ server: { origin: 'https://a.test' }, auth: { oidc: OIDC } }, {}, true)).rejects.toThrow('server.origins')
  })

  it('空段（auth.oidc: {}）算没配', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await (await boot({ auth: { oidc: {}, github: null } })).close()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没有配置登录方式'))
  })

  describe('真实请求', () => {
    let idp: FakeIdp
    let app: NestFastifyApplication | undefined

    beforeEach(async () => {
      idp = await startFakeIdp()
      vi.stubGlobal('fetch', idp.fetch)
    })
    afterEach(async () => {
      await app?.close()
      app = undefined
      await idp.stop()
      vi.unstubAllGlobals()
    })

    it('两个都没配：config 说 enabled:false，/me 还是 enabled:true，/api 仍然 401，login 回登录页说明原因', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const booted = await bootApp({ database: { url: fixture.url } })
      app = booted.app
      const browser = new FakeBrowser(booted.baseUrl, ORIGIN)
      expect(JSON.parse((await browser.get('/api/auth/config')).body)).toEqual({ enabled: false, providers: [] })
      expect(JSON.parse((await browser.get('/api/auth/me')).body)).toEqual({ enabled: true, authenticated: false, user: null })
      expect((await browser.get('/api/private')).status).toBe(401)
      const login = await browser.get('/api/auth/login')
      expect(login.status).toBe(302)
      expect(login.headers.location).toMatch(/^\/login\?error=/)
      const callback = await browser.get('/api/auth/callback?code=x&state=y')
      expect(callback.headers.location).toMatch(/^\/login\?error=/)
    })

    it.each([
      [{ server: { port: 3101 } }, 'localhost:3101', 'http://localhost:3101'],
      [{ server: { port: 3101 } }, '127.0.0.1:3101', 'http://127.0.0.1:3101'],
      [{ server: { port: 3101 } }, 'evil.test', 'http://localhost:3101'],
      [{}, '127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ])('开发环境没配 origins：%j + Host %s → %s', async (values, host, origin) => {
      const booted = await bootApp({ database: { url: fixture.url }, auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } }, ...values })
      app = booted.app
      const res = await new FakeBrowser(booted.baseUrl, `http://${host}`).get('/api/auth/login')
      expect(new URL(res.headers.location as string).searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback`)
    })

    it('没设 PLATFORM_OIDC_CLIENT_SECRET = public client：token 请求不带 client_secret，靠 PKCE', async () => {
      const booted = await bootApp({
        database: { url: fixture.url },
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId, scope: 'openid custom' } },
      })
      app = booted.app
      const browser = new FakeBrowser(booted.baseUrl, ORIGIN)
      const start = await browser.get('/api/auth/login')
      expect(new URL(start.headers.location as string).searchParams.get('scope')).toBe('openid custom')
      await browser.get(await followAuthorize(start.headers.location as string))
      expect(idp.tokenCalls[0].has('client_secret')).toBe(false)
      expect(JSON.parse((await browser.get('/api/auth/me')).body).authenticated).toBe(true)
    })

    it('issuer 按原样比较：配了带尾斜杠的，发现文档不带就报 issuer 不匹配，不建会话', async () => {
      const booted = await bootApp({
        database: { url: fixture.url },
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: `${idp.issuer}/`, clientId: idp.clientId } },
      })
      app = booted.app
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const res = await new FakeBrowser(booted.baseUrl, ORIGIN).get('/api/auth/login')
      expect(res.headers.location).toMatch(/^\/login\?error=/)
    })
  })

  describe('定时清理', () => {
    const expiredRequest = {
      state: 'stale',
      nonce: 'n',
      codeVerifier: 'v',
      provider: 'oidc',
      linkUserId: null,
      redirectTo: '/',
      origin: 'http://app.test',
      expiresAt: new Date(Date.now() - 1000),
    }

    it('启动时清一次；定时器 unref，关闭时清掉', async () => {
      const first = await boot({})
      const em = first.get(DataAccess).em()
      em.create(AuthRequest, { ...expiredRequest })
      await em.flush()
      await first.close()

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
      const context = await boot({})
      expect(await context.get(DataAccess).em().count(AuthRequest)).toBe(0)
      const timer = setIntervalSpy.mock.results.find((result) => setIntervalSpy.mock.calls[setIntervalSpy.mock.results.indexOf(result)][1] === 3600_000)?.value as NodeJS.Timeout
      expect(timer).toBeDefined()
      expect(timer.hasRef()).toBe(false)
      await context.close()
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer)
    })

    it('清理失败只记日志：不挡启动', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const sweep = vi.spyOn(SessionSweeper.prototype, 'sweepExpired').mockRejectedValueOnce(new Error('select leaked-token-value'))
      const context = await boot({})
      expect(error).toHaveBeenCalledWith(expect.stringContaining('清理过期数据失败'))
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('leaked-token-value'))
      sweep.mockRestore()
      await context.close()
    })
  })
})
