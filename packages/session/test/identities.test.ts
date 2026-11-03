import 'reflect-metadata'
import { ClusterModule } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule, User } from '@learning/data-access'
import { FakeBrowser, followAuthorize, startFakeIdp, type BrowserResponse, type FakeIdp } from '@learning/session/testing'
import { Module } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRequest, PendingLink, Session, UserIdentity } from '../src/entities.js'
import { identiconSeed, identiconUrl } from '../src/identicon.js'
import { IdentitiesService } from '../src/identities.service.js'
import { ApiSessionGuard, SessionIdentityModule, SessionModule, SessionService, UserService } from '../src/index.js'
import { GITHUB_ISSUER } from '../src/oauth/index.js'
import { SessionSweeper } from '../src/session-sweeper.js'
import { sessionTokenId } from '../src/session-token.js'
import { bootContext, postgresFixture, sqliteFixture, type DatabaseFixture } from './helpers.js'

/**
 * 账号关联和默认头像，走真 HTTP 和假身份提供方。从 `apps/server/test/store/identities.test.ts`、`apps/server/test/routes/{auth-github,avatars}.test.ts`、
 * `apps/server/test/auth/{profile,session}.test.ts` 移植，提供方 id 换成这里的 `oidc`。
 */
const SECRET = 'test-secret'
const OIDC_SECRET = 'oidc-secret-value'
const GITHUB_SECRET = 'github-secret-value'
const ORIGIN = 'http://app.test'

interface IdentityItem {
  id: string
  provider: string
  label: string
  username: string | null
  email: string | null
  avatarUrl: string | null
  createdAt: string
  lastLoginAt: string | null
  primary: boolean
}
type Provider = 'oidc' | 'github'

async function bootApp(values: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  @Module({})
  class Root {}
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: Root,
      imports: [testConfigModule(values, { env: { PLATFORM_SESSION_SECRET: SECRET, ...env } }), DataAccessModule, ClusterModule, SessionModule],
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

  const em = () => app.get(DataAccess).em()
  const newBrowser = () => new FakeBrowser(baseUrl, ORIGIN)
  const toProvider = (provider: Provider, location: string) => (provider === 'github' ? idp.githubAuthorizeUrl(location) : location)

  const login = async (provider: Provider, of: FakeBrowser = browser) => {
    const start = await of.get(`/api/auth/login?provider=${provider}`)
    return of.get(await followAuthorize(toProvider(provider, start.headers.location as string)))
  }
  /** 走到提供方跳回来，还没访问回调 */
  const authorizeLink = async (provider: Provider, of: FakeBrowser = browser) => {
    const start = await of.get(`/api/auth/link/${provider}`)
    expect(start.status).toBe(302)
    return followAuthorize(toProvider(provider, start.headers.location as string))
  }
  /** 回调走完：只是落了一条待确认 */
  const startLink = async (provider: Provider, of: FakeBrowser = browser) => of.get(await authorizeLink(provider, of))
  const confirm = (of: FakeBrowser = browser) => of.request('POST', '/api/auth/link/confirm')
  const linkAndConfirm = async (provider: Provider, of: FakeBrowser = browser) => {
    expect((await startLink(provider, of)).headers.location).toBe('/settings')
    const res = await confirm(of)
    expect(res.status).toBe(200)
    return JSON.parse(res.body) as { identity: IdentityItem }
  }
  const listing = async (of: FakeBrowser = browser) => JSON.parse((await of.get('/api/auth/identities')).body) as { items: IdentityItem[]; pending: Record<string, unknown> | null }
  const items = async (of: FakeBrowser = browser) => (await listing(of)).items
  const unlink = (id: string, of: FakeBrowser = browser) => of.request('DELETE', `/api/auth/identities/${id}`)
  const me = async (of: FakeBrowser = browser) => (JSON.parse((await of.get('/api/auth/me')).body) as { user: Record<string, unknown> }).user
  const userRow = (id: string) => em().findOneOrFail(User, id)
  const userId = async (of: FakeBrowser = browser) => (await me(of)).id as string
  const linkErrorOf = (res: BrowserResponse) => {
    expect(res.status).toBe(302)
    const location = res.headers.location as string
    expect(location).toMatch(/^\/settings\?link_error=/)
    return new URLSearchParams(location.split('?')[1]).get('link_error') as string
  }
  /** 没有头像的 GitHub 账号：这里关心的是主身份的切换，GitHub 给了头像的话一登录就被它盖掉 */
  const githubWithoutAvatar = () => {
    idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'octo@example.test', avatar_url: null }
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
        session: { ttlSeconds: 3600 },
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId }, github: { clientId: 'gh-client' } },
      },
      { PLATFORM_OIDC_CLIENT_SECRET: OIDC_SECRET, PLATFORM_GITHUB_CLIENT_SECRET: GITHUB_SECRET },
    ))
  })

  afterAll(async () => {
    // 关联走完一整趟，日志里也不能有 token、code 和密钥
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
    await em().nativeDelete(PendingLink, {})
    await em().nativeDelete(UserIdentity, {})
    browser = newBrowser()
    idp.user = { sub: 'alice-sub', preferred_username: 'alice', email: 'alice@example.test', name: 'Alice' }
    idp.roles = { realm: [], client: [] }
    idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'octo@example.test', avatar_url: 'https://avatars.test/octocat.png' }
    idp.github.emails = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('要登录', () => {
    it.each([
      ['GET', '/api/auth/identities'],
      ['GET', '/api/auth/link/github'],
      ['POST', '/api/auth/link/confirm'],
      ['DELETE', '/api/auth/link/pending'],
      ['DELETE', '/api/auth/identities/some-id'],
      ['GET', `/api/avatars/${identiconSeed('i', 's')}.svg`],
    ])('%s %s 未登录 → 401', async (method, target) => {
      const res = await newBrowser().request(method, target)
      expect(res.status).toBe(401)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthorized' })
    })
  })

  describe('发起关联', () => {
    it('没这个提供方 → 404，形状和前端读的一样', async () => {
      await login('oidc')
      const res = await browser.get('/api/auth/link/wechat')
      expect(res.status).toBe(404)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Not Found', message: '没有这个登录方式' })
    })

    it('授权请求带着 linkUserId，落点写死 /settings，不接受 ?redirect=', async () => {
      await login('oidc')
      const id = await userId()
      const res = await browser.get('/api/auth/link/github?redirect=/evil')
      expect(res.status).toBe(302)
      expect(res.headers.location).toContain('https://github.com/login/oauth/authorize')
      expect(browser.cookies.get('oidc_tx')?.path).toBe('/api/auth')
      expect(await em().findOneOrFail(AuthRequest, browser.cookies.get('oidc_tx')?.value as string)).toMatchObject({
        provider: 'github',
        linkUserId: id,
        redirectTo: '/settings',
      })
    })

    it('发现文档拉不到：回设置页说明原因，不留授权请求，也不写 tx cookie', async () => {
      const failing = await startFakeIdp()
      const { app: other, baseUrl: otherUrl } = await bootApp({
        database: { url: fixture.url },
        session: { ttlSeconds: 3600 },
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: failing.issuer, clientId: 'c' } },
      })
      await failing.stop()
      const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'x' })
      const token = await app.get(SessionService).create({
        userId: user.id,
        provider: 'github',
        tokens: { accessToken: 'a', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
      })
      const res = await new FakeBrowser(otherUrl, ORIGIN).get('/api/auth/link/oidc', { cookie: `sid=${token}` })
      await other.close()
      expect(linkErrorOf(res)).toContain('连不上')
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(await em().count(AuthRequest)).toBe(0)
    })
  })

  describe('授权回来：确认前绝不写', () => {
    it('只落一条待确认：干干净净回设置页，没有新绑定，没有换会话，token 也没存', async () => {
      await login('oidc')
      const id = await userId()
      const sidBefore = browser.cookies.get('sid')?.value
      const tokenCalls = idp.github.tokenCalls.length

      const res = await startLink('github')

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('/settings')
      expect(browser.cookies.get('sid')?.value).toBe(sidBefore)
      expect(browser.cookies.has('oidc_tx')).toBe(false)
      expect(idp.github.tokenCalls.length).toBe(tokenCalls + 1)
      expect(await em().count(UserIdentity, { user: id })).toBe(1)
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(0)
      expect(await em().count(Session)).toBe(1)
      expect(await em().count(User)).toBe(1)
      expect(await em().count(AuthRequest)).toBe(0)
      const pendingRow = await em().findOneOrFail(PendingLink, { user: id })
      expect(Object.values(pendingRow).map(String).join(' ')).not.toContain('fake-github-')

      const { items: list, pending } = await listing()
      expect(list).toHaveLength(1)
      // 形状 = PendingLinkView：确认框要的那几个字段，不多带
      expect(pending).toEqual({ provider: 'github', label: 'GitHub', username: 'octocat', email: 'octo@example.test', avatarUrl: 'https://avatars.test/octocat.png' })
    })

    it('确认之后才多一条：不新建用户，会话不变，主身份不变，暂存用掉就没了', async () => {
      await login('oidc')
      const id = await userId()
      const before = await userRow(id)
      await startLink('github')
      const sessionBefore = browser.cookies.get('sid')?.value

      const res = await confirm()

      expect(res.status).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(browser.cookies.get('sid')?.value).toBe(sessionBefore)
      const { identity } = JSON.parse(res.body) as { identity: IdentityItem }
      expect(identity).toMatchObject({ provider: 'github', label: 'GitHub', username: 'octocat', email: 'octo@example.test', primary: false, lastLoginAt: null })
      expect(Date.parse(identity.createdAt)).not.toBeNaN()
      expect(await em().count(User)).toBe(1)
      expect((await items()).map((row) => [row.provider, row.primary])).toEqual([['oidc', true], ['github', false]])
      expect(await userRow(id)).toMatchObject({ issuer: before.issuer, subject: before.subject, name: 'Alice' })
      expect(await em().count(PendingLink)).toBe(0)
      expect((await listing()).pending).toBeNull()
    })

    it('放弃确认：什么都没发生，暂存也清了', async () => {
      await login('oidc')
      await startLink('github')
      const res = await browser.request('DELETE', '/api/auth/link/pending')
      expect(res.status).toBe(204)
      expect(res.body).toBe('')
      expect(await em().count(PendingLink)).toBe(0)
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(0)
    })

    it('没有待确认的还去确认 → 404，不会凭空绑出一条', async () => {
      await login('oidc')
      const res = await confirm()
      expect(res.status).toBe(404)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Not Found' })
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(0)
    })

    it('别人的待确认关联确认不到，也消费不掉', async () => {
      await login('oidc')
      const mine = await userId()
      await startLink('github')

      const other = newBrowser()
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc', other)

      expect((await confirm(other)).status).toBe(404)
      expect((await other.request('DELETE', '/api/auth/link/pending')).status).toBe(204)
      expect((await listing(other)).pending).toBeNull()
      expect(await em().count(PendingLink, { user: mine })).toBe(1)
    })

    it('再发起一次顶掉上一条，不会攒出两条；确认框显示的是最新的', async () => {
      await login('oidc')
      const id = await userId()
      await startLink('github')
      idp.github.user = { id: 9999, login: 'another', name: null, email: null, avatar_url: null }
      await startLink('github')

      expect(await em().count(PendingLink, { user: id })).toBe(1)
      expect((await em().findOneOrFail(PendingLink, { user: id })).subject).toBe('9999')
      expect((await listing()).pending).toMatchObject({ username: 'another', avatarUrl: null })
    })

    it('过期：确认 410 且不写；列表当作没有并顺手删掉', async () => {
      await login('oidc')
      const id = await userId()
      await startLink('github')
      await em().nativeUpdate(PendingLink, { user: id }, { expiresAt: new Date(Date.now() - 1000) })

      const res = await confirm()
      expect(res.status).toBe(410)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Gone' })
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(0)
      expect(await em().count(PendingLink)).toBe(0)

      await startLink('github')
      await em().nativeUpdate(PendingLink, { user: id }, { expiresAt: new Date(Date.now() - 1000) })
      expect((await listing()).pending).toBeNull()
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('十分钟有效', async () => {
      await login('oidc')
      const now = Date.now()
      await startLink('github')
      const { expiresAt } = await em().findOneOrFail(PendingLink, { user: await userId() })
      expect(Math.abs(expiresAt.getTime() - now - 600_000)).toBeLessThan(5_000)
    })

    it('同时确认两次：只有真删掉暂存的那一次算数，另一次是「没有待确认的」，不是「已经关联过了」', async () => {
      await login('oidc')
      await startLink('github')
      const id = await userId()
      // 直接调 service：两边都在对方删除之前读到那一行，经 HTTP 的话时序不稳定
      const service = app.get(IdentitiesService, { strict: false })
      const results = await Promise.all([service.confirmPending(id), service.confirmPending(id)])
      expect(results.map((result) => (result.ok ? 'ok' : result.reason)).sort()).toEqual(['none', 'ok'])
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(1)
    })

    it('反过来也行：GitHub 建的号关联 OIDC，同样先确认；关联不写角色', async () => {
      await login('github')
      const id = await userId()
      idp.roles = { realm: ['admin'], client: [] }
      await startLink('oidc')
      expect(await em().count(UserIdentity, { provider: 'oidc' })).toBe(0)
      expect((await linkAndConfirm('oidc')).identity).toMatchObject({ provider: 'oidc', label: 'OIDC', primary: false })
      expect((await userRow(id)).roles).toBe('[]')
    })

    it('关联之后用它登录进同一个账号，不改显示名，也不清角色', async () => {
      idp.roles = { realm: ['admin'], client: [] }
      await login('oidc')
      const id = await userId()
      await linkAndConfirm('github')

      const other = newBrowser()
      await login('github', other)

      expect(await userId(other)).toBe(id)
      expect(await em().count(User)).toBe(1)
      const row = await userRow(id)
      expect(row.name).toBe('Alice')
      expect(row.roles).toBe('["admin"]')
      // 那一条自己的展示信息和 lastLoginAt 是刷新的
      expect((await items()).find((item) => item.provider === 'github')?.lastLoginAt).not.toBeNull()
    })
  })

  describe('绑不成的情况', () => {
    /** 账号 A 已绑 GitHub 账号 G；B 点「关联」时浏览器在 GitHub 那边还登着 G，这一趟对 B 是无感的，只能由服务端拒绝 */
    it('这个账号绑在别人身上 → 回设置页报错，什么都不留下，B 的会话不动', async () => {
      await login('github')
      const a = await userId()

      const b = newBrowser()
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc', b)
      const bId = await userId(b)
      const sid = b.cookies.get('sid')?.value

      const res = await startLink('github', b)

      expect(linkErrorOf(res)).toContain('已经关联到另一个用户')
      expect((await em().findOneOrFail(UserIdentity, { provider: 'github' })).user.id).toBe(a)
      expect(await em().count(UserIdentity, { user: bId, provider: 'github' })).toBe(0)
      expect(await em().count(PendingLink)).toBe(0)
      expect(await em().count(AuthRequest)).toBe(0)
      expect(res.headers['set-cookie']?.join()).not.toContain('sid=')
      expect(b.cookies.get('sid')?.value).toBe(sid)
      expect(await userId(b)).toBe(bId)
    })

    it('预检过了，确认时已经被别人绑走 → 409，暂存清掉，绑定还是对方的', async () => {
      await login('oidc')
      await startLink('github')

      const other = newBrowser()
      await login('github', other)
      const owner = await userId(other)

      const res = await confirm()
      expect(res.status).toBe(409)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Conflict', message: expect.stringContaining('已经关联到另一个用户') })
      expect((await em().findOneOrFail(UserIdentity, { provider: 'github' })).user.id).toBe(owner)
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('这个账号已经绑在自己身上 → 「关联过了」', async () => {
      await login('oidc')
      await linkAndConfirm('github')
      expect(linkErrorOf(await startLink('github'))).toContain('已经关联过了')
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('自己已经绑了这个提供方的另一个账号 → 「请先解绑」，连确认框都不弹', async () => {
      await login('oidc')
      await linkAndConfirm('github')
      idp.github.user = { id: 9999, login: 'another', name: null, email: null, avatar_url: null }
      expect(linkErrorOf(await startLink('github'))).toContain('请先解绑')
      expect(await em().count(PendingLink)).toBe(0)
      expect(await em().count(UserIdentity)).toBe(2)
    })

    it('预检过了，确认时自己刚绑上同一提供方的另一个账号 → 409「请先解绑」', async () => {
      await login('oidc')
      await startLink('github')
      const id = await userId()
      const tx = em()
      tx.create(UserIdentity, { user: id, provider: 'github', subject: 'other-github', issuer: GITHUB_ISSUER, username: null, email: null, avatarUrl: null, lastLoginAt: null })
      await tx.flush()

      const res = await confirm()
      expect(res.status).toBe(409)
      expect((JSON.parse(res.body) as { message: string }).message).toContain('请先解绑')
    })

    it('用户在提供方那边点了取消 → 回设置页而不是登录页', async () => {
      await login('oidc')
      const start = await browser.get('/api/auth/link/github')
      const state = new URL(start.headers.location as string).searchParams.get('state') as string
      const res = await browser.get(`/api/auth/callback?error=access_denied&error_description=${encodeURIComponent('用户取消')}&state=${state}`)
      expect(linkErrorOf(res)).toBe('用户取消')
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('state 对不上：回设置页报错，不换 token', async () => {
      await login('oidc')
      await browser.get('/api/auth/link/github')
      const calls = idp.github.tokenCalls.length
      const res = await browser.get('/api/auth/callback?code=x&state=wrong')
      expect(linkErrorOf(res)).toContain('state 校验失败')
      expect(idp.github.tokenCalls.length).toBe(calls)
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('授权请求超时：回设置页', async () => {
      await login('oidc')
      const back = await authorizeLink('github')
      await em().nativeUpdate(AuthRequest, { id: browser.cookies.get('oidc_tx')?.value }, { expiresAt: new Date(Date.now() - 1000) })
      expect(linkErrorOf(await browser.get(back))).toContain('超时')
    })

    it('换 token 失败：回设置页，错误信息里不带内部信息，不留待确认', async () => {
      await login('oidc')
      idp.github.tokenOverride = { status: 200, body: { error: 'bad_verification_code', error_description: 'bad code' } }
      const res = await startLink('github')
      idp.github.tokenOverride = null
      expect(linkErrorOf(res)).toBeTruthy()
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('中途换了人（另一个标签页登出又登进别的账号）→ 不能绑到任何一方身上，也不换 token', async () => {
      await login('oidc')
      const back = await authorizeLink('github')
      const tx = browser.cookies.get('oidc_tx')?.value as string

      await browser.get('/api/auth/logout')
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc')

      const calls = idp.github.tokenCalls.length
      // 真浏览器里两趟授权共用一个 tx cookie，后一趟会盖掉它。这里造的是发起关联之后 cookie 还在的那种时序（比如登录发生在另一个域名）
      const res = await browser.get(back, { cookie: `oidc_tx=${tx}; sid=${browser.cookies.get('sid')?.value}` })
      expect(linkErrorOf(res)).toContain('登录状态已变化')
      expect(idp.github.tokenCalls.length).toBe(calls)
      expect(await em().count(PendingLink)).toBe(0)
      expect(await em().count(UserIdentity, { provider: 'github' })).toBe(0)
    })

    it('中途登出：同样拒绝，也不会变成一次登录', async () => {
      await login('oidc')
      const back = await authorizeLink('github')
      await browser.get('/api/auth/logout')
      const res = await browser.get(back)
      expect(linkErrorOf(res)).toContain('登录状态已变化')
      expect(browser.cookies.has('sid')).toBe(false)
      expect(await em().count(Session)).toBe(0)
      expect(await em().count(User)).toBe(1)
    })

    it('重放同一个回调：第二次拒绝，还是那一条待确认', async () => {
      await login('oidc')
      const back = await authorizeLink('github')
      const tx = browser.cookies.get('oidc_tx')?.value as string
      await browser.get(back)
      const replay = await browser.get(back, { cookie: `oidc_tx=${tx}; sid=${browser.cookies.get('sid')?.value}` })
      expect(replay.status).toBe(302)
      expect(replay.headers.location).toMatch(/^\/login\?error=/)
      expect(await em().count(PendingLink)).toBe(1)
    })
  })

  describe('身份只认 (provider, subject)，不认邮箱', () => {
    const SAME = 'same@example.test'

    it('另一个提供方登录，邮箱和已有账号相同：两个账号，已有账号身上不多一条绑定', async () => {
      idp.user = { sub: 'alice-sub', preferred_username: 'alice', email: SAME, name: 'Alice' }
      await login('oidc')
      const alice = await userId()

      idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: SAME, avatar_url: null }
      const other = newBrowser()
      await login('github', other)

      expect(await userId(other)).not.toBe(alice)
      expect(await em().count(User)).toBe(2)
      expect(await items()).toHaveLength(1)
      expect(await items(other)).toHaveLength(1)
      expect(await em().count(PendingLink)).toBe(0)
    })

    it('关联时邮箱和别人一样不算占用：预检和确认都只比 (provider, subject)', async () => {
      idp.github.user = { id: 1, login: 'bob', name: 'Bob', email: SAME, avatar_url: null }
      await login('github')
      const bob = await userId()

      const alice = newBrowser()
      idp.user = { sub: 'alice-sub', preferred_username: 'alice', email: 'alice@example.test', name: 'Alice' }
      await login('oidc', alice)
      idp.github.user = { id: 2, login: 'alice-gh', name: 'Alice', email: SAME, avatar_url: null }

      expect((await linkAndConfirm('github', alice)).identity).toMatchObject({ provider: 'github', username: 'alice-gh', email: SAME })
      expect(await em().count(UserIdentity, { user: bob })).toBe(1)
    })

    it('同一个第三方账号换了邮箱，也还是被占用', async () => {
      await login('github')
      const other = newBrowser()
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc', other)
      idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'changed@example.test', avatar_url: null }
      expect(linkErrorOf(await startLink('github', other))).toContain('已经关联到另一个用户')
    })

    it('解绑之后邮箱还在 User 上，再用那个身份登录也是新账号', async () => {
      await login('oidc')
      const alice = await userId()
      await linkAndConfirm('github')
      const github = (await items()).find((row) => row.provider === 'github') as IdentityItem
      expect((await unlink(github.id)).status).toBe(204)

      idp.github.user = { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'alice@example.test', avatar_url: null }
      const other = newBrowser()
      await login('github', other)
      expect(await userId(other)).not.toBe(alice)
    })
  })

  describe('GET /api/auth/identities', () => {
    it('形状就是 IdentityView，不带 issuer / subject；不缓存', async () => {
      await login('oidc')
      const res = await browser.get('/api/auth/identities')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      const [row] = (JSON.parse(res.body) as { items: IdentityItem[] }).items
      expect(Object.keys(row).sort()).toEqual(['avatarUrl', 'createdAt', 'email', 'id', 'label', 'lastLoginAt', 'primary', 'provider', 'username'])
      expect(row).toMatchObject({ provider: 'oidc', label: 'OIDC', username: 'alice', email: 'alice@example.test', primary: true })
    })

    it('还没有 identity 行的用户读列表时补出主身份，真的落库', async () => {
      const user = await app.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'legacy', username: 'old' })
      const token = await app.get(SessionService).create({
        userId: user.id,
        provider: 'oidc',
        tokens: { accessToken: 'a', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
      })
      const cookie = { cookie: `sid=${token}` }

      const [first, second] = await Promise.all([browser.get('/api/auth/identities', cookie), browser.get('/api/auth/identities', cookie)])

      for (const res of [first, second]) {
        expect(res.status).toBe(200)
        expect((JSON.parse(res.body) as { items: IdentityItem[] }).items).toMatchObject([{ provider: 'oidc', label: 'OIDC', primary: true, username: 'old' }])
      }
      expect(await em().count(UserIdentity, { user: user.id })).toBe(1)
    })

    it('GitHub 建的号补出来的是 github，不是默认的 oidc', async () => {
      const user = await app.get(UserService).findOrCreate({ issuer: GITHUB_ISSUER, subject: '4242' })
      const token = await app.get(SessionService).create({
        userId: user.id,
        provider: 'github',
        tokens: { accessToken: 'a', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
      })
      const res = await browser.get('/api/auth/identities', { cookie: `sid=${token}` })
      expect((JSON.parse(res.body) as { items: IdentityItem[] }).items).toMatchObject([{ provider: 'github', label: 'GitHub', primary: true }])
    })

    it('还没有 identity 行就来确认：先把主身份补出来，两条都在账上，主身份不变', async () => {
      const user = await app.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'legacy' })
      const token = await app.get(SessionService).create({
        userId: user.id,
        provider: 'oidc',
        tokens: { accessToken: 'a', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
      })
      const em0 = em()
      em0.create(PendingLink, { user: user.id, provider: 'github', subject: '4242', issuer: GITHUB_ISSUER, username: 'octocat', email: null, avatarUrl: null, expiresAt: new Date(Date.now() + 60_000) })
      await em0.flush()
      const cookie = { cookie: `sid=${token}` }

      expect((await browser.request('POST', '/api/auth/link/confirm', cookie)).status).toBe(200)

      const { items: rows } = JSON.parse((await browser.get('/api/auth/identities', cookie)).body) as { items: IdentityItem[] }
      // 补出来的和新绑的可能落在同一毫秒，这里不比先后
      expect(rows.map((row) => [row.provider, row.primary]).sort()).toEqual([['github', false], ['oidc', true]])
    })
  })

  describe('DELETE /api/auth/identities/:id', () => {
    it('只剩一条 → 409，绝不允许把自己锁在外面', async () => {
      await login('oidc')
      const [only] = await items()
      const res = await unlink(only.id)
      expect(res.status).toBe(409)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Conflict', message: '至少要保留一种登录方式' })
      expect(await em().count(UserIdentity)).toBe(1)
    })

    it('不是自己的那条 → 404，不泄露别人有什么', async () => {
      await login('oidc')
      const other = newBrowser()
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc', other)
      const [victim] = await items(other)
      expect((await unlink(victim.id)).status).toBe(404)
      expect(await em().count(UserIdentity)).toBe(2)
    })

    it('不存在 → 404', async () => {
      await login('oidc')
      expect((await unlink('no-such-id')).status).toBe(404)
    })

    it('解绑主身份 → 204，剩下的被提升，User 的 (issuer, subject) 改写；显示名、头像、会话都不变', async () => {
      await login('oidc')
      const id = await userId()
      const before = await userRow(id)
      await linkAndConfirm('github')
      const primary = (await items()).find((row) => row.primary) as IdentityItem

      const res = await unlink(primary.id)

      expect(res.status).toBe(204)
      expect(res.body).toBe('')
      const after = await userRow(id)
      expect(after).toMatchObject({ issuer: GITHUB_ISSUER, subject: '4242', name: 'Alice', username: 'alice', email: 'alice@example.test', avatarUrl: before.avatarUrl })
      expect((await items()).map((row) => [row.provider, row.primary])).toEqual([['github', true]])
      expect(await me()).toMatchObject({ id, name: 'Alice' })
      expect(await em().count(Session)).toBe(1)

      // 被解绑的那条再登录是另一个新账号，提升上来的那条还是这个人
      const other = newBrowser()
      await login('oidc', other)
      expect(await userId(other)).not.toBe(id)
      const again = newBrowser()
      await login('github', again)
      expect(await userId(again)).toBe(id)
    })

    it('解绑副身份 → 主身份原样不动', async () => {
      await login('oidc')
      const id = await userId()
      const before = await userRow(id)
      await linkAndConfirm('github')
      const secondary = (await items()).find((row) => !row.primary) as IdentityItem
      expect((await unlink(secondary.id)).status).toBe(204)
      expect(await userRow(id)).toMatchObject({ issuer: before.issuer, subject: before.subject })
      expect((await items()).map((row) => row.provider)).toEqual(['oidc'])
    })

    it('两个标签页同时解绑仅有的两条：只有一条解得掉，人还登得进来', async () => {
      await login('oidc')
      const id = await userId()
      await linkAndConfirm('github')
      const rows = await items()

      // 直接调 service：两边都在对方提交之前读列表，经 HTTP 的话时序不稳定
      const service = app.get(IdentitiesService, { strict: false })
      const results = await Promise.all(rows.map((row) => service.unlink(id, row.id)))

      expect(results.sort()).toEqual(['last', 'ok'])
      const left = await items()
      expect(left).toHaveLength(1)
      expect(left[0].primary).toBe(true)
      expect(await em().count(UserIdentity, { user: id })).toBe(1)
    })

    it('解绑后还能重新关联回来', async () => {
      await login('oidc')
      await linkAndConfirm('github')
      const github = (await items()).find((row) => row.provider === 'github') as IdentityItem
      await unlink(github.id)
      expect((await linkAndConfirm('github')).identity.provider).toBe('github')
    })
  })

  describe('默认头像', () => {
    it('提供方没给头像：登录后 /me 里是 identicon，库里也是，能当 <img src> 取到', async () => {
      await login('oidc')
      const row = await userRow(await userId())
      expect(row.avatarUrl).toBe(identiconUrl(idp.issuer, 'alice-sub'))
      expect((await me()).avatarUrl).toBe(row.avatarUrl)

      const res = await browser.get(row.avatarUrl as string)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('image/svg+xml')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.body).toContain('<svg')
    })

    it('提供方给了 picture：用它，不被覆盖；之后 picture 没了也不换成 identicon', async () => {
      idp.user = { sub: 'alice-sub', preferred_username: 'alice', name: 'Alice', picture: 'https://cdn.test/me.png' }
      await login('oidc')
      const id = await userId()
      expect((await userRow(id)).avatarUrl).toBe('https://cdn.test/me.png')

      idp.user = { sub: 'alice-sub', preferred_username: 'alice', name: 'Alice' }
      await login('oidc', newBrowser())
      expect((await userRow(id)).avatarUrl).toBe('https://cdn.test/me.png')
    })

    it('先是 identicon，后来提供方给了 picture：picture 优先', async () => {
      await login('oidc')
      const id = await userId()
      expect((await userRow(id)).avatarUrl).toContain('/api/avatars/')
      idp.user = { sub: 'alice-sub', preferred_username: 'alice', name: 'Alice', picture: 'https://cdn.test/me.png' }
      await login('oidc', newBrowser())
      expect((await userRow(id)).avatarUrl).toBe('https://cdn.test/me.png')
    })

    it('同一个人每次登录都是同一张图', async () => {
      await login('oidc')
      const first = (await me()).avatarUrl
      const again = newBrowser()
      await login('oidc', again)
      expect((await me(again)).avatarUrl).toBe(first)
    })

    it('还没有头像的用户（上线前登录的）下次登录补上', async () => {
      await login('oidc')
      const id = await userId()
      await em().nativeUpdate(User, { id }, { avatarUrl: null })
      expect((await me()).avatarUrl).toBeNull()
      await login('oidc', newBrowser())
      expect((await userRow(id)).avatarUrl).toBe(identiconUrl(idp.issuer, 'alice-sub'))
    })

    it('种子稳定：解绑主身份、用提升上来的身份再登录，还是原来那张图', async () => {
      githubWithoutAvatar()
      await login('oidc')
      const id = await userId()
      const original = (await userRow(id)).avatarUrl
      expect(original).toBe(identiconUrl(idp.issuer, 'alice-sub'))
      await linkAndConfirm('github')
      await unlink(((await items()).find((row) => row.primary) as IdentityItem).id)
      expect(await userRow(id)).toMatchObject({ issuer: GITHUB_ISSUER, avatarUrl: original })

      const again = newBrowser()
      await login('github', again)

      expect(await userId(again)).toBe(id)
      expect((await userRow(id)).avatarUrl).toBe(original)
      expect(original).not.toBe(identiconUrl(GITHUB_ISSUER, '4242'))
    })

    it('用副身份登录，头像不跟它走', async () => {
      await login('oidc')
      const id = await userId()
      const original = (await userRow(id)).avatarUrl
      await linkAndConfirm('github')
      await login('github', newBrowser())
      expect((await userRow(id)).avatarUrl).toBe(original)
    })

    it('不带 .svg 后缀也能取；种子形状不对 → 404，且不按不可变资源缓存', async () => {
      await login('oidc')
      expect((await browser.get(`/api/avatars/${identiconSeed('i', 's')}`)).status).toBe(200)
      for (const seed of ['abc', 'ZZZZZZZZZZZZZZZZ', '../../etc/passwd']) {
        const res = await browser.get(`/api/avatars/${encodeURIComponent(seed)}`)
        expect(res.status, seed).toBe(404)
        expect(res.headers['cache-control'], seed).toBeUndefined()
      }
    })

    it('只引入身份模块的进程（协同副本）读到同一个值：只读和续期两条路都是', async () => {
      await login('oidc')
      const token = browser.cookies.get('sid')?.value as string
      const expected = identiconUrl(idp.issuer, 'alice-sub')

      const replica = await bootContext([
        testConfigModule({ database: { url: fixture.url, schemaSync: 'off' }, session: { ttlSeconds: 3600 } }, { env: { PLATFORM_SESSION_SECRET: SECRET } }),
        DataAccessModule,
        ClusterModule,
        SessionIdentityModule,
      ])
      const sessions = replica.get(SessionService)
      expect((await sessions.load(token))?.user.avatarUrl).toBe(expected)
      expect((await sessions.load(token, { refresh: false }))?.user.avatarUrl).toBe(expected)
      // 这个进程看不到 UserIdentity：副本的读取路径不能依赖它
      expect([...replica.get(DataAccess).orm.getMetadata().getAll().values()].map((meta) => meta.className).sort()).toEqual(['Session', 'User'])
      await replica.close()
    })
  })

  describe('定时清理', () => {
    it('sweepExpired 清掉过期的待确认关联，没过期的留着', async () => {
      await login('oidc')
      const alice = await userId()
      await startLink('github')
      const other = newBrowser()
      idp.user = { sub: 'bob-sub', preferred_username: 'bob', email: 'bob@example.test', name: 'Bob' }
      await login('oidc', other)
      idp.github.user = { id: 9999, login: 'another', name: null, email: null, avatar_url: null }
      await startLink('github', other)
      await em().nativeUpdate(PendingLink, { user: alice }, { expiresAt: new Date(Date.now() - 1000) })

      const sweeper = app.get(SessionSweeper, { strict: false })
      expect(await sweeper.sweepExpired()).toEqual({ sessions: 0, authRequests: 0, pendingLinks: 1 })

      expect(await em().count(PendingLink, { user: alice })).toBe(0)
      expect(await em().count(PendingLink)).toBe(1)
    })

    it('会话 id 仍然是 HMAC：关联没有多建会话，也没有动它', async () => {
      await login('oidc')
      await linkAndConfirm('github')
      const sid = browser.cookies.get('sid')?.value as string
      expect(await em().findOne(Session, sessionTokenId(SECRET, sid))).not.toBeNull()
      expect(await em().count(Session)).toBe(1)
    })
  })
}

describe('账号关联和头像（SQLite）', () => {
  behaviours(sqliteFixture)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('账号关联和头像（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(() => postgresFixture(postgresUrl as string))
})
