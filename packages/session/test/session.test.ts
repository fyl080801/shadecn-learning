import 'reflect-metadata'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule, User } from '@learning/data-access'
import { Controller, Get, type INestApplicationContext, Module, UseGuards } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRequest, Session } from '../src/entities.js'
import { CurrentUser, SessionGuard, SessionModule, SessionService, type SessionUser, UserService } from '../src/index.js'
import { SessionSweeper } from '../src/session-sweeper.js'
import { sessionTokenId } from '../src/session-token.js'
import { readCookie } from '../src/session.guard.js'
import { bootContext, postgresFixture, sessionConfig, sqliteFixture, type DatabaseFixture } from './helpers.js'

const SECRET = 'test-secret'
const HOUR = 3600 * 1000

const liveTokens = (overrides: { expiresAt?: Date } = {}) => ({
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  idToken: 'id-token-value',
  expiresAt: overrides.expiresAt ?? new Date(Date.now() + HOUR),
  refreshExpiresAt: null,
  sessionState: 'session-state-value',
})

@Controller('api')
class ProfileController {
  // 构造函数类型注入 + 模块不 import SessionModule：global 导出够用
  constructor(readonly users: UserService) {}

  @UseGuards(SessionGuard)
  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return user
  }

  @Get('no-guard')
  noGuard(@CurrentUser() user: SessionUser) {
    return user
  }
}

@Module({ controllers: [ProfileController] })
class ProfileModule {}

function behaviours(createFixture: () => DatabaseFixture) {
  let fixture: DatabaseFixture
  let context: INestApplicationContext
  let users: UserService
  let sessions: SessionService
  let dataAccess: DataAccess

  const createFor = async (subject = 'alice', overrides: { expiresAt?: Date } = {}) => {
    const user = await users.findOrCreate({ issuer: 'https://issuer.test', subject })
    const token = await sessions.create({ userId: user.id, provider: 'keycloak', tokens: liveTokens(overrides) })
    return { user, token, id: sessionTokenId(SECRET, token) }
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    fixture = createFixture()
    await fixture.open()
    context = await bootContext([
      sessionConfig(fixture.url, { secret: SECRET, ttlSeconds: 3600 }),
      DataAccessModule,
      SessionModule,
    ])
    users = context.get(UserService)
    sessions = context.get(SessionService)
    dataAccess = context.get(DataAccess)
  })

  afterAll(async () => {
    await context.close()
    await fixture.dispose()
    vi.restoreAllMocks()
  })

  beforeEach(() => fixture.clear())

  describe('SessionService', () => {
    it('库里的 id 是 HMAC，不等于 token；token 不落库', async () => {
      const { token, id } = await createFor()
      expect(id).not.toBe(token)
      const row = await dataAccess.em().findOneOrFail(Session, id)
      expect(Object.values(row)).not.toContain(token)
      expect(await dataAccess.em().findOne(Session, token)).toBeNull()
    })

    it('load 带着 user；不存在 / 没有 token → null', async () => {
      const { token, user } = await createFor()
      expect((await sessions.load(token))?.user.id).toBe(user.id)
      expect(await sessions.load('no-such-token')).toBeNull()
      expect(await sessions.load(undefined)).toBeNull()
    })

    it('换一个 secret 读不到同一个 token，而且不删行', async () => {
      const { token, id } = await createFor()
      const other = await bootContext([
        sessionConfig(fixture.url, { secret: 'another-secret' }),
        DataAccessModule,
        SessionModule,
      ])
      expect(await other.get(SessionService).load(token)).toBeNull()
      await other.close()
      expect(await dataAccess.em().findOne(Session, id)).not.toBeNull()
    })

    it('活过 ttl：删行并返回 null，即使 expiresAt 还没到', async () => {
      const { token, id } = await createFor()
      await dataAccess.em().nativeUpdate(Session, { id }, { createdAt: new Date(Date.now() - 2 * HOUR) })
      expect(await sessions.load(token)).toBeNull()
      expect(await dataAccess.em().findOne(Session, id)).toBeNull()
    })

    it('expiresAt 已过：删行并返回 null（没有提供方可以续期）', async () => {
      const { token, id } = await createFor('alice', { expiresAt: new Date(Date.now() - 1000) })
      expect(await sessions.load(token)).toBeNull()
      expect(await dataAccess.em().findOne(Session, id)).toBeNull()
    })

    it('sweepExpired 只删活过 ttl 的会话和过期的授权请求，access_token 过期的留给 load 判，不碰用户', async () => {
      const live = await createFor('live')
      const tooOld = await createFor('old')
      await dataAccess.em().nativeUpdate(Session, { id: tooOld.id }, { createdAt: new Date(Date.now() - 2 * HOUR) })
      const lapsed = await createFor('lapsed', { expiresAt: new Date(Date.now() - 1000) })
      const em0 = dataAccess.em()
      const authRequest = (expiresAt: Date, state: string) => ({
        state,
        nonce: 'n',
        codeVerifier: 'v',
        provider: 'oidc',
        linkUserId: null,
        redirectTo: '/',
        origin: 'http://app.test',
        expiresAt,
      })
      em0.create(AuthRequest, authRequest(new Date(Date.now() - 1000), 'stale'))
      em0.create(AuthRequest, authRequest(new Date(Date.now() + HOUR), 'pending'))
      await em0.flush()

      const sweeper = context.get(SessionSweeper, { strict: false })
      expect(await sweeper.sweepExpired()).toEqual({ sessions: 1, authRequests: 1 })

      const em = dataAccess.em()
      expect(await em.findOne(Session, live.id)).not.toBeNull()
      expect(await em.findOne(Session, tooOld.id)).toBeNull()
      expect(await em.findOne(Session, lapsed.id)).not.toBeNull()
      expect((await em.find(AuthRequest, {})).map((row) => row.state)).toEqual(['pending'])
      expect(await em.count(User)).toBe(3)
      expect(await sweeper.sweepExpired()).toEqual({ sessions: 0, authRequests: 0 })
    })

    it('deleteByToken 幂等：删过再删、不存在、undefined 都不抛', async () => {
      const { token, id } = await createFor()
      await sessions.deleteByToken(token)
      expect(await dataAccess.em().findOne(Session, id)).toBeNull()
      await sessions.deleteByToken(token)
      await sessions.deleteByToken('no-such-token')
      await sessions.deleteByToken(undefined)
    })
  })

  describe('UserService', () => {
    const issuer = 'https://issuer.test'

    it('findOrCreate 新建时可空字段写 null，roles 存 JSON', async () => {
      const user = await users.findOrCreate({ issuer, subject: 'a', roles: ['admin'] })
      const row = await dataAccess.em().findOneOrFail(User, user.id)
      expect(row).toMatchObject({ username: null, email: null, name: null, avatarUrl: null, lastLoginAt: null, roles: '["admin"]' })
      expect(user.username).toBeNull()
    })

    it('findOrCreate 重复调用：同一行，一个字段都不改', async () => {
      const first = await users.findOrCreate({ issuer, subject: 'a', name: '原名', email: 'a@test', roles: ['x'] })
      const again = await users.findOrCreate({ issuer, subject: 'a', name: '新名', email: 'b@test', roles: ['y'] })
      expect(again.id).toBe(first.id)
      expect(again).toMatchObject({ name: '原名', email: 'a@test', roles: '["x"]' })
      expect(again.updatedAt.getTime()).toBe(first.updatedAt.getTime())
    })

    it('身份只认 (issuer, subject)：同邮箱不同 subject 是两个人', async () => {
      const a = await users.findOrCreate({ issuer, subject: 'a', email: 'same@test' })
      const b = await users.findOrCreate({ issuer, subject: 'b', email: 'same@test' })
      expect(a.id).not.toBe(b.id)
    })

    it('findOrCreate 并发不报错：只有一行，大家拿到同一个 id', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => users.findOrCreate({ issuer, subject: 'race' })))
      expect(new Set(results.map((user) => user.id)).size).toBe(1)
      expect(await dataAccess.em().count(User, { subject: 'race' })).toBe(1)
    })

    it('findById：有就返回，没有 → null', async () => {
      const user = await users.findOrCreate({ issuer, subject: 'a' })
      expect((await users.findById(user.id))?.subject).toBe('a')
      expect(await users.findById('no-such-id')).toBeNull()
    })
  })

  describe('SessionGuard（真实 Fastify 请求）', () => {
    let app: NestFastifyApplication
    let baseUrl: string

    const get = (path: string, cookie?: string) =>
      fetch(`${baseUrl}${path}`, cookie === undefined ? {} : { headers: { cookie } })

    beforeAll(async () => {
      app = await NestFactory.create<NestFastifyApplication>(
        {
          module: class Root {},
          imports: [
            ProfileModule,
            sessionConfig(fixture.url, { secret: SECRET, ttlSeconds: 3600 }),
            DataAccessModule,
            SessionModule,
          ],
        },
        new FastifyAdapter(),
        { logger: false, abortOnError: false },
      )
      await app.listen(0, '127.0.0.1')
      baseUrl = await app.getUrl()
    })

    afterAll(() => app.close())

    it.each([
      ['没有 cookie', undefined],
      ['别的 cookie', 'other=1'],
      ['假 token', 'sid=forged-token'],
      ['畸形百分号编码', 'sid=%E0%A4%A'],
      ['没有等号', 'sid'],
      ['空值', 'sid='],
      ['__proto__ 名字的 cookie', '__proto__=x; constructor=y'],
    ])('%s → 401', async (_name, cookie) => {
      const response = await get('/api/me', cookie)
      expect(response.status).toBe(401)
    })

    it('会话过期 → 401', async () => {
      const { token } = await createFor('alice', { expiresAt: new Date(Date.now() - 1000) })
      expect((await get('/api/me', `sid=${token}`)).status).toBe(401)
    })

    it('有效 → 200；@CurrentUser() 拿到 SessionUser，里面没有任何 token 字段', async () => {
      const { token, user } = await createFor()
      const response = await get('/api/me', `other=1; sid=${token}; __proto__=x`)
      expect(response.status).toBe(200)

      const text = await response.text()
      const body = JSON.parse(text) as SessionUser
      expect(Object.keys(body).sort()).toEqual(['avatarUrl', 'email', 'id', 'name', 'roles', 'subject', 'username'])
      expect(body).toMatchObject({ id: user.id, subject: 'alice', roles: [] })
      for (const secret of [token, 'access-token-value', 'refresh-token-value', 'id-token-value', 'session-state-value']) {
        expect(text).not.toContain(secret)
      }
    })

    it('守卫所在的模块不 import SessionModule：上面的 ProfileModule 本身就是这种情况，service 也注入得到', () => {
      expect(app.get(ProfileController).users).toBeInstanceOf(UserService)
    })

    it('@CurrentUser() 没配守卫是代码写错了：500，不是 401，也不是空用户', async () => {
      expect((await get('/api/no-guard')).status).toBe(500)
    })
  })
}

describe('用户和会话（SQLite）', () => {
  behaviours(sqliteFixture)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('用户和会话（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(() => postgresFixture(postgresUrl as string))
})

describe('session 配置段', () => {
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

  const bootWith = (session: { secret?: string } & Record<string, unknown>, isProduction = false) =>
    bootContext([sessionConfig(fixture.url, session, { isProduction }), DataAccessModule, SessionModule])

  it.each([{}, { secret: '' }, { secret: '   ' }])('生产环境缺密钥（%j）→ 启动失败', async (session) => {
    await expect(bootWith(session, true)).rejects.toThrow('PLATFORM_SESSION_SECRET')
  })

  it.each(['hunter2', '', 12345])('config.yaml 里写了 session.secret（%j）→ 启动失败，不带值', async (secret) => {
    const failure = bootContext([
      testConfigModule(
        { database: { url: fixture.url }, session: { secret } },
        { env: { PLATFORM_SESSION_SECRET: SECRET } },
      ),
      DataAccessModule,
      SessionModule,
    ])
    await expect(failure).rejects.toThrow('密钥不能写在 config.yaml')
    await expect(failure).rejects.not.toThrow('hunter2')
  })

  it.each([{}, { secret: '' }, { secret: '   ' }])('非生产环境缺密钥（%j）→ 警告并用临时密钥，每次启动都不同', async (session) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = await bootWith(session)
    const second = await bootWith(session)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('PLATFORM_SESSION_SECRET'))).toHaveLength(2)

    const user = await first.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'a' })
    const token = await first.get(SessionService).create({ userId: user.id, provider: 'keycloak', tokens: liveTokens() })
    expect(await first.get(SessionService).load(token)).not.toBeNull()
    expect(await second.get(SessionService).load(token)).toBeNull()
    await first.close()
    await second.close()
  })

  it('设了密钥 → 不警告密钥，前后空白不算密钥的一部分（生产也能起）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const context = await bootWith({ secret: `  ${SECRET}  ` }, true)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('PLATFORM_SESSION_SECRET'))
    const user = await context.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'a' })
    const token = await context.get(SessionService).create({ userId: user.id, provider: 'keycloak', tokens: liveTokens() })
    const row = await context.get(DataAccess).em().findOne(Session, sessionTokenId(SECRET, token))
    expect(row).not.toBeNull()
    await context.close()
  })

  it.each([
    ['ttlSeconds 是 0', { secret: SECRET, ttlSeconds: 0 }, 'ttlSeconds'],
    ['ttlSeconds 是负数', { secret: SECRET, ttlSeconds: -1 }, 'ttlSeconds'],
    ['ttlSeconds 是 NaN', { secret: SECRET, ttlSeconds: Number.NaN }, 'ttlSeconds'],
    ['ttlSeconds 是字符串', { secret: SECRET, ttlSeconds: '3600' }, 'ttlSeconds'],
    ['cookieName 不是字符串', { secret: SECRET, cookieName: 1 }, 'session.cookieName 必须是字符串'],
  ])('%s → 启动失败', async (_name, session, message) => {
    await expect(bootWith(session)).rejects.toThrow(message)
  })

  it('这一段不是映射 → 启动失败', async () => {
    await expect(
      bootContext([testConfigModule({ database: { url: fixture.url }, session: 'secret' }), DataAccessModule, SessionModule]),
    ).rejects.toThrow('session 段必须是映射')
  })

  it('cookieName 生效', async () => {
    const context = await bootWith({ secret: SECRET, cookieName: 'custom' })
    expect(context.get(SessionService).cookieName).toBe('custom')
    await context.close()
  })

  it('默认值和 mod-auth 对齐：cookie 名 sid，ttl 7 天', async () => {
    const context = await bootWith({ secret: SECRET })
    const users = context.get(UserService)
    const sessions = context.get(SessionService)
    const dataAccess = context.get(DataAccess)
    expect(sessions.cookieName).toBe('sid')

    const user = await users.findOrCreate({ issuer: 'https://issuer.test', subject: 'a' })
    const token = await sessions.create({ userId: user.id, provider: 'keycloak', tokens: liveTokens() })
    const id = sessionTokenId(SECRET, token)
    const DAY = 24 * HOUR

    await dataAccess.em().nativeUpdate(Session, { id }, { createdAt: new Date(Date.now() - 7 * DAY + HOUR) })
    expect(await sessions.load(token)).not.toBeNull()
    await dataAccess.em().nativeUpdate(Session, { id }, { createdAt: new Date(Date.now() - 7 * DAY - HOUR) })
    expect(await sessions.load(token)).toBeNull()

    await context.close()
  })
})

describe('readCookie', () => {
  it('按名字取值，容忍空格，多个同名取第一个', () => {
    expect(readCookie('a=1; sid=abc ;b=2', 'sid')).toBe('abc')
    expect(readCookie('sid=first; sid=second', 'sid')).toBe('first')
    expect(readCookie('a=1', 'sid')).toBeUndefined()
    expect(readCookie(undefined, 'sid')).toBeUndefined()
    expect(readCookie(['sid=1'], 'sid')).toBeUndefined()
  })

  it('值里可以有等号；百分号编码解开，不合法时返回原文而不是抛错', () => {
    expect(readCookie('sid=a=b', 'sid')).toBe('a=b')
    expect(readCookie('sid=a%20b', 'sid')).toBe('a b')
    expect(readCookie('sid=%E0%A4%A', 'sid')).toBe('%E0%A4%A')
  })

  it('__proto__ / constructor 这样的名字不碰原型：没有就是 undefined，有就是字面值', () => {
    expect(readCookie('sid=1', '__proto__')).toBeUndefined()
    expect(readCookie('sid=1', 'constructor')).toBeUndefined()
    expect(readCookie('__proto__=x', '__proto__')).toBe('x')
    expect(({} as { polluted?: string }).polluted).toBeUndefined()
  })
})
