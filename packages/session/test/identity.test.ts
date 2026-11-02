import 'reflect-metadata'
import { ClusterModule } from '@learning/cluster'
import { ConfigService } from '@learning/config'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule, User } from '@learning/data-access'
import { startFakeIdp, type FakeIdp } from '@learning/session/testing'
import { Controller, Get, Module } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOidcOptions } from '../src/auth-options.js'
import { AuthRequest, Session } from '../src/entities.js'
import { ApiSessionGuard, LoginModule, Public, SessionIdentityModule, SessionModule, SessionService, UserService } from '../src/index.js'
import { SessionSweeper } from '../src/session-sweeper.js'
import { bootContext, sqliteFixture } from './helpers.js'

const SECRET = 'test-secret'
const HOUR = 3600 * 1000

@Controller('api')
class RoutesController {
  @Get('secret')
  secret() {
    return { ok: true }
  }

  @Public()
  @Get('open')
  open() {
    return { ok: true }
  }
}

const tables = async (dataAccess: DataAccess) => {
  const rows = (await dataAccess.orm.driver
    .getConnection()
    .execute(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`)) as { name: string }[]
  return rows.map((row) => row.name).sort()
}

describe('只引入 SessionIdentityModule 的进程（协同这类服务）', () => {
  let dir: ReturnType<typeof sqliteFixture>
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = sqliteFixture()
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await dir.dispose()
  })

  const config = (values: Record<string, unknown> = {}, env: Record<string, string> = {}, isProduction = false) =>
    testConfigModule({ database: { url: dir.url }, ...values }, { isProduction, env: { PLATFORM_SESSION_SECRET: SECRET, ...env } })

  it('只建 user 和 session 表；登录模块的表和清理都不在', async () => {
    const context = await bootContext([config(), DataAccessModule, ClusterModule, SessionIdentityModule])
    expect(await tables(context.get(DataAccess))).toEqual(['session', 'user'])
    expect(() => context.get(SessionSweeper, { strict: false })).toThrow()
    await context.close()
  })

  it('不暴露 /api/auth/*；ApiSessionGuard 照样挡 /api，@Public 照样放行；会话有效就过', async () => {
    @Module({ controllers: [RoutesController] })
    class RoutesModule {}
    const app = await NestFactory.create<NestFastifyApplication>(
      {
        module: class Root {},
        imports: [RoutesModule, config(), DataAccessModule, ClusterModule, SessionIdentityModule],
        providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
      },
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    )
    await app.listen(0, '127.0.0.1')
    const url = await app.getUrl()

    // 路由根本不存在：Fastify 直接 404，走不到守卫（apps/platform 的 401 来自 @learning/web 的回退路由，它是 Nest 控制器）
    for (const path of ['/api/auth/me', '/api/auth/config', '/api/auth/login', '/api/auth/callback', '/api/auth/logout']) {
      expect((await fetch(`${url}${path}`, { redirect: 'manual' })).status, path).toBe(404)
    }
    expect((await fetch(`${url}/api/secret`)).status).toBe(401)
    expect((await fetch(`${url}/api/open`)).status).toBe(200)

    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'alice' })
    const token = await app.get(SessionService).create({
      userId: user.id,
      provider: 'oidc',
      tokens: {
        accessToken: 'a',
        refreshToken: null,
        idToken: null,
        expiresAt: new Date(Date.now() + HOUR),
        refreshExpiresAt: null,
        sessionState: null,
      },
    })
    const cookie = { headers: { cookie: `sid=${token}` } }
    expect((await fetch(`${url}/api/secret`, cookie)).status).toBe(200)
    expect((await fetch(`${url}/api/auth/me`, cookie)).status).toBe(404)
    await app.close()
  })

  it('不跑清理：启动时不删任何行（活过 ttl 的会话由 load 判），也不开定时器', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const seed = await bootContext([config(), DataAccessModule, ClusterModule, SessionModule])
    const em = seed.get(DataAccess).em()
    const user = em.create(User, {
      issuer: 'i',
      subject: 's',
      username: null,
      email: null,
      name: null,
      avatarUrl: null,
      roles: '[]',
      lastLoginAt: null,
    })
    em.create(Session, {
      id: 'old',
      user,
      provider: 'oidc',
      accessToken: 'a',
      refreshToken: null,
      idToken: null,
      expiresAt: new Date(Date.now() + HOUR),
      refreshExpiresAt: null,
      sessionState: null,
      userAgent: null,
      ip: null,
      createdAt: new Date(0),
    })
    em.create(AuthRequest, {
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      provider: 'oidc',
      linkUserId: null,
      redirectTo: '/',
      origin: 'http://app.test',
      expiresAt: new Date(0),
    })
    await em.flush()
    await seed.close()
    setIntervalSpy.mockClear()

    const context = await bootContext([config(), DataAccessModule, ClusterModule, SessionIdentityModule])
    const hourly = setIntervalSpy.mock.calls.filter((call) => call[1] === HOUR)
    expect(hourly).toEqual([])
    const rows = await context.get(DataAccess).orm.driver.getConnection().execute('select id from session')
    expect(rows).toEqual([{ id: 'old' }])
    // 库里还有登录模块的表：不在实体集里，只提醒，不动
    const left = await context.get(DataAccess).orm.driver.getConnection().execute('select state from auth_request')
    expect(left).toEqual([{ state: 's' }])
    await context.close()
  })

  it('配置只看身份要的：auth.github 写了一半、没有 server.origins 也能起（生产环境）；auth.oidc 写一半照样拒绝', async () => {
    const github = { auth: { github: { clientId: 'g' } } }
    const context = await bootContext([config(github, {}, true), DataAccessModule, ClusterModule, SessionIdentityModule])
    await context.close()

    const oidcOnly = { auth: { oidc: { issuer: 'https://idp.test/realms/x', clientId: 'c' } } }
    const noOrigins = await bootContext([config(oidcOnly, {}, true), DataAccessModule, ClusterModule, SessionIdentityModule])
    await noOrigins.close()

    const half = new ConfigService({
      rootDir: '/',
      dataDir: '/data',
      isProduction: false,
      values: { auth: { oidc: { issuer: 'https://idp.test' } } },
    })
    expect(() => resolveOidcOptions(half)).toThrow('auth.oidc.clientId')
  })

  describe('续期（配了 auth.oidc）', () => {
    let idp: FakeIdp

    beforeEach(async () => {
      idp = await startFakeIdp({ clientSecret: 'oidc-secret-value' })
      vi.stubGlobal('fetch', idp.fetch)
    })
    afterEach(() => idp.stop())

    const expiring = (refreshToken: string | null) => ({
      accessToken: 'old-access',
      refreshToken,
      idToken: null,
      expiresAt: new Date(Date.now() + 1000),
      refreshExpiresAt: null,
      sessionState: null,
    })

    const boot = (auth: Record<string, unknown>) =>
      bootContext([
        config({ auth }, { PLATFORM_OIDC_CLIENT_SECRET: 'oidc-secret-value' }),
        DataAccessModule,
        ClusterModule,
        SessionIdentityModule,
      ])

    it('快过期的 OIDC 会话能续：不需要登录模块', async () => {
      const context = await boot({ oidc: { issuer: idp.issuer, clientId: idp.clientId } })
      const user = await context.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'alice' })
      const sessions = context.get(SessionService)
      const token = await sessions.create({ userId: user.id, provider: 'oidc', tokens: expiring('refresh-me') })

      const loaded = await sessions.load(token)
      expect(loaded?.accessToken).not.toBe('old-access')
      expect(idp.tokenCalls.map((call) => call.get('grant_type'))).toEqual(['refresh_token'])
      await context.close()
    })

    it('GitHub 会话续不了，到点就结束：这个进程不需要 GitHub 的配置和密钥', async () => {
      const context = await boot({ oidc: { issuer: idp.issuer, clientId: idp.clientId } })
      const user = await context.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'bob' })
      const sessions = context.get(SessionService)
      const token = await sessions.create({ userId: user.id, provider: 'github', tokens: expiring(null) })

      expect(await sessions.load(token)).toBeNull()
      expect(idp.tokenCalls).toEqual([])
      await context.close()
    })

    it('冷却表不会无限长：暂时失败的会话到期后，下一次失败时顺手清掉', async () => {
      idp.tokenOverride = () => ({ status: 500, body: { error: 'server_error' } })
      const context = await boot({ oidc: { issuer: idp.issuer, clientId: idp.clientId } })
      const user = await context.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'carol' })
      const sessions = context.get(SessionService)
      const first = await sessions.create({ userId: user.id, provider: 'oidc', tokens: expiring('r1') })
      const second = await sessions.create({ userId: user.id, provider: 'oidc', tokens: expiring('r2') })
      const cooldown = (sessions as unknown as { cooldown: Map<string, number> }).cooldown

      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      expect(await sessions.load(first)).not.toBeNull()
      expect(cooldown.size).toBe(1)

      clock.mockReturnValue(now + 16_000)
      expect(await sessions.load(second)).not.toBeNull()
      expect(cooldown.size).toBe(1)
      clock.mockRestore()
      await context.close()
    })
  })

  it('全新库同步后差异为空，再启动一次打印「无需变更」：实体写法不会让每次启动都算出差异', async () => {
    const first = await bootContext([config(), DataAccessModule, ClusterModule, SessionModule])
    expect(await first.get(DataAccess).orm.schema.getUpdateSchemaSQL({ dropTables: false })).toBe('')
    await first.close()

    log.mockClear()
    const second = await bootContext([config(), DataAccessModule, ClusterModule, SessionModule])
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[data-access\] 表结构已与实体定义一致/))
    await second.close()
  })

  it('SessionModule = 身份 + 登录：五张表都在；单独引入 LoginModule 也能启动（它自己 import 了身份模块）', async () => {
    const whole = await bootContext([config(), DataAccessModule, ClusterModule, SessionModule])
    expect(await tables(whole.get(DataAccess))).toEqual(['auth_request', 'pending_link', 'session', 'user', 'user_identity'])
    await whole.close()

    const loginOnly = await bootContext([config(), DataAccessModule, ClusterModule, LoginModule])
    expect(await tables(loginOnly.get(DataAccess))).toEqual(['auth_request', 'pending_link', 'session', 'user', 'user_identity'])
    await loginOnly.close()
  })
})
