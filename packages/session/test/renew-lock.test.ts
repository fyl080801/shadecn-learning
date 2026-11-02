import 'reflect-metadata'
import { Cluster, ClusterModule, type ClusterBackend, SharedLock, SharedLockUnavailableError } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { startFakeIdp, type FakeIdp } from '@learning/session/testing'
import type { DynamicModule, INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Session } from '../src/entities.js'
import { SessionIdentityModule, SessionModule, SessionService, type SessionTokens, UserService } from '../src/index.js'
import { HTTP_TIMEOUT } from '../src/oauth/index.js'
import { RENEW_LOCK_TTL_MS } from '../src/session.service.js'
import { SessionSweeper } from '../src/session-sweeper.js'
import { sessionTokenId } from '../src/session-token.js'
import { bootContext, sqliteFixture } from './helpers.js'

const SECRET = 'test-secret'
const CLIENT_SECRET = 'oidc-secret-value'
const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

/**
 * Redis 实现的语义，不用真的 Redis（真的 Redis 下面用 PLATFORM_TEST_REDIS_URL 跑同一组用例）：
 * 抢不到锁的等释放，然后跑 fallback，不共享 promise。一个进程内的实例共用它，就相当于两个进程共用一台 Redis。
 */
class CrossProcessLock extends SharedLock {
  private readonly held = new Map<string, Promise<void>>()
  /** 抢锁之前跑一下：造「读到旧行之后，别的进程先做完了」 */
  beforeAcquire: (() => Promise<void>) | null = null
  /** 抢锁直接失败：造 Redis 故障 */
  unavailable = false
  /** 锁被一个已经崩溃的持有者占着：等待期满跑 fallback */
  heldByCrashedPeer = false
  attempts = 0

  constructor() {
    super('session-renew')
  }

  async run<T>(key: string, task: () => Promise<T>, options: { fallback: () => Promise<T>; ttlMs: number }): Promise<T> {
    this.attempts += 1
    const before = this.beforeAcquire
    this.beforeAcquire = null
    await before?.()
    if (this.unavailable) throw new SharedLockUnavailableError(new Error('connection refused'))
    if (this.heldByCrashedPeer) return options.fallback()

    const holding = this.held.get(key)
    if (holding) {
      await holding
      return options.fallback()
    }
    let release = () => {}
    this.held.set(key, new Promise((resolve) => (release = resolve)))
    try {
      return await task()
    } finally {
      this.held.delete(key)
      release()
    }
  }
}

function fakeClusterModule(lock: SharedLock): DynamicModule {
  const backend: ClusterBackend = { createLock: () => lock, close: () => Promise.resolve() }
  return {
    module: class FakeClusterModule {},
    global: true,
    providers: [{ provide: Cluster, useFactory: () => new Cluster('redis', backend) }],
    exports: [Cluster],
  }
}

const expiring = (refreshToken: string | null): SessionTokens => ({
  accessToken: 'old-access',
  refreshToken,
  idToken: null,
  expiresAt: new Date(Date.now() + 1000),
  refreshExpiresAt: null,
  sessionState: null,
})

describe('续期锁的 TTL', () => {
  it('大于持锁期间最坏的两次 HTTP 超时（发现文档 + token 端点），否则锁过期后第二个进程会拿旧 refresh token 去换', () => {
    expect(RENEW_LOCK_TTL_MS).toBeGreaterThan(2 * HTTP_TIMEOUT)
  })
})

/** 同一组「两个进程」的语义，共享锁可以是假的，也可以是真的 Redis */
function twoProcesses(name: string, clusterImport: () => DynamicModule | typeof ClusterModule, extraEnv: Record<string, string>) {
  describe(name, () => {
    let dir: ReturnType<typeof sqliteFixture>
    let idp: FakeIdp
    let a: INestApplicationContext
    let b: INestApplicationContext
    let sessionsA: SessionService
    let sessionsB: SessionService
    /** refresh token 真的轮换：同一个用第二次就是 invalid_grant */
    const spent = new Set<string>()

    const refreshCalls = () => idp.tokenCalls.filter((params) => params.get('grant_type') === 'refresh_token').length

    const bootProcess = (auth: Record<string, unknown>) =>
      bootContext([
        testConfigModule(
          { database: { url: dir.url }, auth },
          { env: { PLATFORM_SESSION_SECRET: SECRET, PLATFORM_OIDC_CLIENT_SECRET: CLIENT_SECRET, ...extraEnv } },
        ),
        DataAccessModule,
        clusterImport(),
        SessionIdentityModule,
      ])

    const row = async (token: string) =>
      a.get(DataAccess).em().findOne(Session, sessionTokenId(SECRET, token))

    const seed = async (refreshToken: string | null = 'refresh-1', provider = 'oidc') => {
      const user = await a.get(UserService).findOrCreate({ issuer: idp.issuer, subject: `user-${Math.random()}` })
      return sessionsA.create({ userId: user.id, provider, tokens: expiring(refreshToken) })
    }

    beforeEach(async () => {
      dir = sqliteFixture()
      spent.clear()
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      idp = await startFakeIdp({ clientSecret: CLIENT_SECRET })
      idp.tokenDelayMs = 50
      idp.tokenOverride = (params) => {
        const token = params.get('refresh_token')
        if (!token) return null
        if (spent.has(token)) return { status: 400, body: { error: 'invalid_grant' } }
        spent.add(token)
        return null
      }
      vi.stubGlobal('fetch', idp.fetch)
      const auth = { oidc: { issuer: idp.issuer, clientId: idp.clientId } }
      a = await bootProcess(auth)
      b = await bootProcess(auth)
      sessionsA = a.get(SessionService)
      sessionsB = b.get(SessionService)
      expect(sessionsA).not.toBe(sessionsB)
    })

    afterEach(async () => {
      await a.close()
      await b.close()
      await idp.stop()
      await dir.dispose()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('两个进程并发续同一个会话：token 端点只调一次，都拿到新 token，会话没被注销', async () => {
      const token = await seed()
      const [fromA, fromB] = await Promise.all([sessionsA.load(token), sessionsB.load(token)])

      expect(refreshCalls()).toBe(1)
      expect(fromA?.accessToken).not.toBe('old-access')
      expect(fromB?.accessToken).toBe(fromA?.accessToken)
      const stored = await row(token)
      expect(stored?.accessToken).toBe(fromA?.accessToken)
      expect(stored?.refreshToken).not.toBe('refresh-1')
    })

    it('每个进程都有多个并发请求：还是只调一次', async () => {
      const token = await seed()
      const results = await Promise.all([
        sessionsA.load(token),
        sessionsB.load(token),
        sessionsA.load(token),
        sessionsB.load(token),
        sessionsA.load(token),
      ])
      expect(refreshCalls()).toBe(1)
      expect(new Set(results.map((session) => session?.accessToken)).size).toBe(1)
      expect(results.every(Boolean)).toBe(true)
    })

    it('对方续期暂时失败（500）：两边都保留旧会话，不注销，等的一方不去换；冷却之后才再试', async () => {
      const token = await seed()
      idp.tokenOverride = () => ({ status: 500, body: { error: 'server_error' } })

      const [fromA, fromB] = await Promise.all([sessionsA.load(token), sessionsB.load(token)])
      expect(refreshCalls()).toBe(1)
      expect(fromA?.accessToken).toBe('old-access')
      expect(fromB?.accessToken).toBe('old-access')

      // 两边都在冷却：再来一轮不碰提供方
      idp.tokenCalls.length = 0
      await Promise.all([sessionsA.load(token), sessionsB.load(token)])
      expect(refreshCalls()).toBe(0)
      expect(await row(token)).not.toBeNull()
    })

    it('提供方明确回绝：赢家注销，等的一方读到行没了 → null，且不再去换', async () => {
      const token = await seed()
      idp.tokenOverride = () => ({ status: 400, body: { error: 'invalid_grant' } })
      const results = await Promise.all([sessionsA.load(token), sessionsB.load(token)])
      expect(refreshCalls()).toBe(1)
      expect(results).toEqual([null, null])
      expect(await row(token)).toBeNull()
    })

    it('GitHub 会话（没有 refresh token）到期：不用锁，直接删', async () => {
      const token = await seed(null, 'github')
      expect(await sessionsB.load(token)).toBeNull()
      expect(refreshCalls()).toBe(0)
      expect(await row(token)).toBeNull()
    })
  })
}

const sharedFake = new CrossProcessLock()
twoProcesses('两个进程 + 共享锁（Redis 语义的假实现）', () => fakeClusterModule(sharedFake), {})

if (redisUrl) twoProcesses('两个进程 + 共享锁（真实 Redis，PLATFORM_TEST_REDIS_URL）', () => ClusterModule, { PLATFORM_REDIS_URL: redisUrl })

describe('共享锁的降级', () => {
  let dir: ReturnType<typeof sqliteFixture>
  let idp: FakeIdp
  let a: INestApplicationContext
  let b: INestApplicationContext
  let lock: CrossProcessLock
  let warn: MockInstance<typeof console.warn>

  const refreshCalls = () => idp.tokenCalls.filter((params) => params.get('grant_type') === 'refresh_token').length

  beforeEach(async () => {
    dir = sqliteFixture()
    lock = new CrossProcessLock()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    idp = await startFakeIdp({ clientSecret: CLIENT_SECRET })
    vi.stubGlobal('fetch', idp.fetch)
    const boot = () =>
      bootContext([
        testConfigModule(
          { database: { url: dir.url }, auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } } },
          { env: { PLATFORM_SESSION_SECRET: SECRET, PLATFORM_OIDC_CLIENT_SECRET: CLIENT_SECRET } },
        ),
        DataAccessModule,
        fakeClusterModule(lock),
        SessionIdentityModule,
      ])
    a = await boot()
    b = await boot()
  })

  afterEach(async () => {
    await a.close()
    await b.close()
    await idp.stop()
    await dir.dispose()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const seed = async (refreshToken: string | null = 'refresh-1') => {
    const user = await a.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'alice' })
    return a.get(SessionService).create({ userId: user.id, provider: 'oidc', tokens: expiring(refreshToken) })
  }
  const stored = (token: string) => a.get(DataAccess).em().findOneOrFail(Session, sessionTokenId(SECRET, token))

  it('Redis 故障：不注销、不在无锁状态下去换，保留旧会话并冷却；冷却内不再撞锁；恢复后能续', async () => {
    const token = await seed()
    lock.unavailable = true
    const sessions = a.get(SessionService)

    const during = await sessions.load(token)
    expect(during?.accessToken).toBe('old-access')
    expect(refreshCalls()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('共享锁不可用'))

    const attempts = lock.attempts
    expect((await sessions.load(token))?.accessToken).toBe('old-access')
    expect(lock.attempts).toBe(attempts)

    lock.unavailable = false
    const realNow = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 16_000)
    const after = await sessions.load(token)
    clock.mockRestore()
    expect(after?.accessToken).not.toBe('old-access')
    expect(refreshCalls()).toBe(1)
  })

  it('等待超时（持有者崩溃，锁过期才放开）：读到旧行 → 保留旧会话并冷却，不拿 refresh token 去换', async () => {
    const token = await seed()
    lock.heldByCrashedPeer = true
    expect((await b.get(SessionService).load(token))?.accessToken).toBe('old-access')
    expect(refreshCalls()).toBe(0)
    expect((await stored(token)).refreshToken).toBe('refresh-1')

    const attempts = lock.attempts
    await b.get(SessionService).load(token)
    expect(lock.attempts).toBe(attempts)
  })

  it('读到旧行之后别的进程先续好并放开了锁：抢到锁也不再换（锁里重读一遍）', async () => {
    const token = await seed()
    const sessionsA = a.get(SessionService)
    const sessionsB = b.get(SessionService)
    const used = new Set<string>()
    idp.tokenOverride = (params) => {
      const refreshToken = params.get('refresh_token') as string
      if (used.has(refreshToken)) return { status: 400, body: { error: 'invalid_grant' } }
      used.add(refreshToken)
      return null
    }
    lock.beforeAcquire = async () => {
      // B 已经过了锁外的那次读，正要抢锁，A 抢先做完
      await sessionsA.load(token)
    }
    const fromB = await sessionsB.load(token)
    expect(refreshCalls()).toBe(1)
    expect(fromB?.accessToken).not.toBe('old-access')
    expect(await stored(token)).not.toBeNull()
  })

  it('invalid_grant 但行上的 refresh token 已经换了（锁过期后别的进程续好的）：不注销，用新行', async () => {
    const token = await seed()
    idp.tokenOverride = () => {
      // 锁过期，别的进程在这个请求换 token 的途中把行续好了
      void a.get(DataAccess).em().nativeUpdate(
        Session,
        { id: sessionTokenId(SECRET, token) },
        { refreshToken: 'rotated-by-peer', accessToken: 'peer-access', expiresAt: new Date(Date.now() + 3600_000) },
      )
      return { status: 400, body: { error: 'invalid_grant' } }
    }
    idp.tokenDelayMs = 30
    const session = await b.get(SessionService).load(token)
    expect(session?.accessToken).toBe('peer-access')
    expect((await stored(token)).refreshToken).toBe('rotated-by-peer')
  })

  it('持锁期间查库失败：照常抛（500），不能说成锁不可用', async () => {
    const token = await seed()
    const sessions = a.get(SessionService)
    const boom = new Error('数据库挂了')
    lock.beforeAcquire = () => {
      vi.spyOn(a.get(DataAccess), 'em').mockImplementationOnce(() => {
        throw boom
      })
      return Promise.resolve()
    }
    await expect(sessions.load(token)).rejects.toBe(boom)
  })
})

describe('未配 auth.oidc 的进程', () => {
  let dir: ReturnType<typeof sqliteFixture>
  let idp: FakeIdp
  let withOidc: INestApplicationContext
  let without: INestApplicationContext
  let warn: MockInstance<typeof console.warn>

  beforeEach(async () => {
    dir = sqliteFixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    idp = await startFakeIdp({ clientSecret: CLIENT_SECRET })
    vi.stubGlobal('fetch', idp.fetch)
    const lock = new CrossProcessLock()
    withOidc = await bootContext([
      testConfigModule(
        { database: { url: dir.url }, session: { ttlSeconds: 3600 }, auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } } },
        { env: { PLATFORM_SESSION_SECRET: SECRET, PLATFORM_OIDC_CLIENT_SECRET: CLIENT_SECRET } },
      ),
      DataAccessModule,
      fakeClusterModule(lock),
      SessionModule,
    ])
    without = await bootContext([
      testConfigModule({ database: { url: dir.url }, session: { ttlSeconds: 3600 } }, { env: { PLATFORM_SESSION_SECRET: SECRET } }),
      DataAccessModule,
      fakeClusterModule(lock),
      SessionIdentityModule,
    ])
  })

  afterEach(async () => {
    await without.close()
    await withOidc.close()
    await idp.stop()
    await dir.dispose()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const seed = async (tokens: SessionTokens, provider = 'oidc') => {
    const user = await withOidc.get(UserService).findOrCreate({ issuer: idp.issuer, subject: 'alice' })
    return withOidc.get(SessionService).create({ userId: user.id, provider, tokens })
  }
  const rowOf = (token: string) => withOidc.get(DataAccess).em().findOne(Session, sessionTokenId(SECRET, token))
  const noClientWarnings = () => warn.mock.calls.filter((call) => String(call[0]).includes('没有配置 oidc 的 client')).length

  it('会话还有可用的 refresh token：本次按未登录，不删行，配了 OIDC 的进程接着能续', async () => {
    const token = await seed(expiring('refresh-1'))
    expect(await without.get(SessionService).load(token)).toBeNull()
    expect(await rowOf(token)).not.toBeNull()
    expect(await without.get(SessionService).exists(token)).toBe(true)

    const renewed = await withOidc.get(SessionService).load(token)
    expect(renewed?.accessToken).not.toBe('old-access')
  })

  it('警告限频：一连串请求只打一次，隔够久再打一次', async () => {
    const token = await seed(expiring('refresh-1'))
    const sessions = without.get(SessionService)
    for (let i = 0; i < 5; i++) await sessions.load(token)
    expect(noClientWarnings()).toBe(1)

    const realNow = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000)
    await sessions.load(token)
    clock.mockRestore()
    expect(noClientWarnings()).toBe(2)
  })

  it('GitHub 会话（没有 refresh token）到期：照旧删', async () => {
    const token = await seed(expiring(null), 'github')
    expect(await without.get(SessionService).load(token)).toBeNull()
    expect(await rowOf(token)).toBeNull()
  })

  it('refresh token 已经过期：会话确实结束了，照旧删', async () => {
    const token = await seed({ ...expiring('refresh-1'), refreshExpiresAt: new Date(Date.now() - 1000) })
    expect(await without.get(SessionService).load(token)).toBeNull()
    expect(await rowOf(token)).toBeNull()
  })

  it('这些行不会永远留着：活过 TTL 后 load 删，SessionSweeper 也按 TTL 回收', async () => {
    const byLoad = await seed(expiring('refresh-1'))
    const bySweep = await seed(expiring('refresh-2'))
    const em = withOidc.get(DataAccess).em()
    await em.nativeUpdate(Session, {}, { createdAt: new Date(Date.now() - 2 * 3600_000) })

    expect(await without.get(SessionService).load(byLoad)).toBeNull()
    expect(await rowOf(byLoad)).toBeNull()

    expect(await withOidc.get(SessionSweeper, { strict: false }).sweepExpired()).toEqual({ sessions: 1, authRequests: 0 })
    expect(await rowOf(bySweep)).toBeNull()
  })
})
