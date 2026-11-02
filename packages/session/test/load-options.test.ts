import 'reflect-metadata'
import { Cluster, type ClusterBackend, createMemoryBackend, SharedLock } from '@learning/cluster'
import { ConfigService } from '@learning/config'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { startFakeIdp, type FakeIdp } from '@learning/session/testing'
import type { DynamicModule, INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../src/entities.js'
import { displayNameOf, normalizeOrigin, readCookie, RequestOrigins, SessionIdentityModule, SessionService, type SessionTokens, UserService } from '../src/index.js'
import { sessionTokenId } from '../src/session-token.js'
import { bootContext, sqliteFixture } from './helpers.js'

const SECRET = 'test-secret'
const CLIENT_SECRET = 'oidc-secret-value'
const HOUR = 3600 * 1000

/** 数一下抢了几次锁：只读调用一次都不该抢 */
class CountingLock extends SharedLock {
  attempts = 0
  constructor() {
    super('session-renew')
  }
  run<T>(_key: string, task: () => Promise<T>): Promise<T> {
    this.attempts += 1
    return task()
  }
}

function clusterWith(lock: SharedLock): DynamicModule {
  const backend: ClusterBackend = { ...createMemoryBackend(), createLock: () => lock }
  return {
    module: class CountingClusterModule {},
    global: true,
    providers: [{ provide: Cluster, useFactory: () => new Cluster('single', backend) }],
    exports: [Cluster],
  }
}

const tokens = (overrides: Partial<SessionTokens> = {}): SessionTokens => ({
  accessToken: 'old-access',
  refreshToken: 'refresh-1',
  idToken: null,
  expiresAt: new Date(Date.now() + 1000),
  refreshExpiresAt: null,
  sessionState: null,
  ...overrides,
})

describe('load(token, { refresh: false })：只读，不续、不写库', () => {
  let dir: ReturnType<typeof sqliteFixture>
  let idp: FakeIdp
  let context: INestApplicationContext
  let sessions: SessionService
  let lock: CountingLock

  const refreshCalls = () => idp.tokenCalls.filter((params) => params.get('grant_type') === 'refresh_token').length

  const seed = async (input: SessionTokens, provider = 'oidc') => {
    const user = await context.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'alice' })
    return sessions.create({ userId: user.id, provider, tokens: input })
  }
  /** 整行快照：只读调用前后必须逐字段相同 */
  const snapshot = async (token: string) => {
    const row = await context.get(DataAccess).em().findOne(Session, sessionTokenId(SECRET, token))
    return row && { ...row, user: row.user.id }
  }

  beforeEach(async () => {
    dir = sqliteFixture()
    lock = new CountingLock()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    idp = await startFakeIdp({ clientSecret: CLIENT_SECRET })
    vi.stubGlobal('fetch', idp.fetch)
    context = await bootContext([
      testConfigModule(
        { database: { url: dir.url }, session: { ttlSeconds: 3600 }, auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } } },
        { env: { PLATFORM_SESSION_SECRET: SECRET, PLATFORM_OIDC_CLIENT_SECRET: CLIENT_SECRET } },
      ),
      DataAccessModule,
      clusterWith(lock),
      SessionIdentityModule,
    ])
    sessions = context.get(SessionService)
  })

  afterEach(async () => {
    await context.close()
    await idp.stop()
    await dir.dispose()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('还没到期：返回会话', async () => {
    const token = await seed(tokens({ expiresAt: new Date(Date.now() + HOUR) }))
    expect((await sessions.load(token, { refresh: false }))?.accessToken).toBe('old-access')
  })

  it('快到期、有 refresh token：返回旧会话；不碰提供方、不抢锁、行一个字段都不变', async () => {
    const token = await seed(tokens())
    const before = await snapshot(token)
    expect((await sessions.load(token, { refresh: false }))?.accessToken).toBe('old-access')
    expect(refreshCalls()).toBe(0)
    expect(lock.attempts).toBe(0)
    expect(await snapshot(token)).toEqual(before)
  })

  it('握手（默认和 refresh: true）照常续期：同一个会话，只读不续，紧接着的真实请求才续', async () => {
    const token = await seed(tokens())
    await sessions.load(token, { refresh: false })
    expect(refreshCalls()).toBe(0)
    expect((await sessions.load(token))?.accessToken).not.toBe('old-access')
    expect(refreshCalls()).toBe(1)

    const second = await seed(tokens({ refreshToken: 'refresh-2' }))
    expect((await sessions.load(second, { refresh: true }))?.accessToken).not.toBe('old-access')
    expect(refreshCalls()).toBe(2)
  })

  it('活过 TTL：null，**不删行**（mod-auth 的只读路径这里会删，规则是 never deletes）；真实请求才删', async () => {
    const token = await seed(tokens({ expiresAt: new Date(Date.now() + HOUR) }))
    await context.get(DataAccess).em().nativeUpdate(Session, { id: sessionTokenId(SECRET, token) }, { createdAt: new Date(Date.now() - 2 * HOUR) })
    const before = await snapshot(token)

    expect(await sessions.load(token, { refresh: false })).toBeNull()
    expect(await snapshot(token)).toEqual(before)

    expect(await sessions.load(token)).toBeNull()
    expect(await snapshot(token)).toBeNull()
  })

  it.each([
    ['GitHub 会话到期（没有 refresh token）', { refreshToken: null }, 'github'],
    ['refresh token 过期', { refreshExpiresAt: new Date(Date.now() - 1000) }, 'oidc'],
    ['这个进程没有对应的 client', {}, 'removed'],
  ])('%s：null，不删行', async (_name, overrides, provider) => {
    const token = await seed(tokens(overrides), provider)
    const before = await snapshot(token)
    expect(await sessions.load(token, { refresh: false })).toBeNull()
    expect(await snapshot(token)).toEqual(before)
    expect(refreshCalls()).toBe(0)
  })

  it('不搭正在进行的续期：提供方卡住时只读调用立刻拿到库里的行', async () => {
    const token = await seed(tokens())
    idp.tokenDelayMs = 300
    const renewal = sessions.load(token)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = Date.now()
    expect((await sessions.load(token, { refresh: false }))?.accessToken).toBe('old-access')
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect((await renewal)?.accessToken).not.toBe('old-access')
  })

  it('不进冷却、也不看冷却：提供方故障不影响只读，冷却结束后真实请求照常重试', async () => {
    const token = await seed(tokens())
    idp.tokenOverride = () => ({ status: 500, body: { error: 'server_error' } })
    expect((await sessions.load(token))?.accessToken).toBe('old-access')
    expect(refreshCalls()).toBe(1)
    expect((await sessions.load(token, { refresh: false }))?.accessToken).toBe('old-access')
    expect(refreshCalls()).toBe(1)
  })

  it('不存在或没有 token：null', async () => {
    expect(await sessions.load('no-such-token', { refresh: false })).toBeNull()
    expect(await sessions.load(undefined, { refresh: false })).toBeNull()
  })
})

describe('给协同用的导出', () => {
  it('displayNameOf：name → username → email → 匿名用户', () => {
    expect(displayNameOf({ name: 'N', username: 'U', email: 'E' })).toBe('N')
    expect(displayNameOf({ name: null, username: 'U', email: 'E' })).toBe('U')
    expect(displayNameOf({ name: null, username: null, email: 'E' })).toBe('E')
    expect(displayNameOf({ name: null, username: null, email: null })).toBe('匿名用户')
    // 空串不是缺失：和原实现、前端的 ?? 一致
    expect(displayNameOf({ name: '', username: 'U', email: 'E' })).toBe('')
  })

  it('RequestOrigins：白名单内跟着请求走，白名单外回落第一个，绝不盲信 Host；没配白名单时回落本机地址', () => {
    const origins = new RequestOrigins(new ConfigService({ rootDir: '/x', dataDir: '/x', isProduction: true, values: { server: { origins: ['https://a.test', 'https://b.test'] } } }))
    expect(origins.of({ headers: { host: 'b.test' }, protocol: 'https' })).toBe('https://b.test')
    expect(origins.of({ headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test' }, protocol: 'https' })).toBe('https://a.test')

    const local = new RequestOrigins(new ConfigService({ rootDir: '/x', dataDir: '/x', isProduction: true, values: { server: { port: 4000 } } }))
    expect(local.list).toEqual(['http://localhost:4000', 'http://127.0.0.1:4000'])
  })

  it('readCookie、normalizeOrigin 从入口可用', () => {
    expect(readCookie('a=1; sid=x%20y', 'sid')).toBe('x y')
    expect(normalizeOrigin('HTTPS://A.test:443/x')).toBe('https://a.test')
  })
})
