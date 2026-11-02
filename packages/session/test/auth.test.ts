import 'reflect-metadata'
import http from 'node:http'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { Controller, Get, Module } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../src/entities.js'
import { ApiSessionGuard, Public, SessionModule, SessionPageAuth, SessionService, UserService } from '../src/index.js'
import { safeRedirect } from '../src/redirect.js'
import { sessionTokenId } from '../src/session-token.js'
import { bootContext, postgresFixture, sessionConfig, sqliteFixture, type DatabaseFixture } from './helpers.js'

const SECRET = 'test-secret'

@Controller()
class RoutesController {
  @Get('api/private')
  secret() {
    return { secret: 'private-data' }
  }

  @Public()
  @Get('api/open')
  open() {
    return { open: true }
  }

  @Get('page')
  page() {
    return { page: true }
  }
}

@Public()
@Controller('api/public-class')
class PublicClassController {
  @Get()
  index() {
    return { open: true }
  }
}

const liveTokens = () => ({
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  idToken: 'id-token-value',
  expiresAt: new Date(Date.now() + 3600_000),
  refreshExpiresAt: null,
  sessionState: 'session-state-value',
})

/** fetch 会规整路径，绕过用例要原样发 */
function rawRequest(baseUrl: string, target: string, cookie?: string) {
  const { hostname, port } = new URL(baseUrl)
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname, port, path: target, headers: cookie ? { cookie } : {} }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function behaviours(createFixture: () => DatabaseFixture) {
  let fixture: DatabaseFixture
  let app: NestFastifyApplication
  let baseUrl: string
  const get = (target: string, cookie?: string) => rawRequest(baseUrl, target, cookie)

  const signIn = async () => {
    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'alice' })
    const token = await app.get(SessionService).create({ userId: user.id, provider: 'keycloak', tokens: liveTokens() })
    return { user, token, id: sessionTokenId(SECRET, token), cookie: `sid=${token}` }
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    fixture = createFixture()
    await fixture.open()
    @Module({ controllers: [RoutesController, PublicClassController] })
    class RoutesModule {}
    @Module({})
    class Root {}
    app = await NestFactory.create<NestFastifyApplication>(
      {
        module: Root,
        imports: [RoutesModule, sessionConfig(fixture.url, { secret: SECRET }), DataAccessModule, SessionModule],
        providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
      },
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    )
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  afterAll(async () => {
    await app.close()
    await fixture.dispose()
    vi.restoreAllMocks()
  })

  beforeEach(() => fixture.clear())

  describe('ApiSessionGuard', () => {
    it.each([
      ['无 cookie', undefined],
      ['假 token', 'sid=forged'],
      ['畸形 cookie', 'sid=%E0%A4%A'],
    ])('%s → 401，响应体带前端读的字段，不含数据', async (_name, cookie) => {
      const res = await get('/api/private', cookie)
      expect(res.status).toBe(401)
      expect(JSON.parse(res.body)).toMatchObject({ statusCode: 401, error: 'Unauthorized' })
      expect(res.body).not.toContain('private-data')
    })

    it('有效会话 → 200', async () => {
      const { cookie } = await signIn()
      const res = await get('/api/private', cookie)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ secret: 'private-data' })
    })

    it('@Public()：方法上、类上都匿名可达', async () => {
      expect((await get('/api/open')).status).toBe(200)
      expect((await get('/api/public-class')).status).toBe(200)
    })

    it('非 /api 放行（页面由 web 的闸门负责）', async () => {
      expect((await get('/page')).status).toBe(200)
    })

    it('Fastify 匹配路由前会解码路径：/%61pi/private 命中受保护路由，不能因为 url 不以 /api 开头就放行', async () => {
      const res = await get('/%61pi/private')
      expect(res.status).toBe(401)
      expect(res.body).not.toContain('private-data')
    })
  })

  describe('GET /api/auth/me', () => {
    it('无 cookie：200，未登录，不写 cookie', async () => {
      const res = await get('/api/auth/me')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ enabled: true, authenticated: false, user: null })
      expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('无效 cookie：200，未登录，并清掉 cookie（http 下不带 Secure）', async () => {
      const res = await get('/api/auth/me', 'sid=forged')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ enabled: true, authenticated: false, user: null })
      expect(res.headers['set-cookie']).toEqual(['sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
    })

    it('有效：只有 SessionUser 的字段，没有任何 token 字段或值', async () => {
      const { user, token, cookie } = await signIn()
      const res = await get('/api/auth/me', cookie)
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['set-cookie']).toBeUndefined()
      const body = JSON.parse(res.body) as { authenticated: boolean; user: Record<string, unknown> }
      expect(body.authenticated).toBe(true)
      expect(body.user.id).toBe(user.id)
      expect(Object.keys(body.user).sort()).toEqual(['avatarUrl', 'email', 'id', 'name', 'roles', 'subject', 'username'])
      for (const secret of [token, 'access-token-value', 'refresh-token-value', 'id-token-value', 'session-state-value']) {
        expect(res.body).not.toContain(secret)
      }
    })
  })

  describe('GET /api/auth/logout', () => {
    it('删行、清 cookie、302 到登录页；会话随之失效', async () => {
      const { id, cookie } = await signIn()
      const res = await get('/api/auth/logout', cookie)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('/login')
      expect(res.headers['set-cookie']).toEqual(['sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
      expect(await app.get(DataAccess).em().findOne(Session, id)).toBeNull()
      expect((await get('/api/private', cookie)).status).toBe(401)
    })

    it('幂等：无 cookie、已删过、假 token 都是 302', async () => {
      const { cookie } = await signIn()
      await get('/api/auth/logout', cookie)
      expect((await get('/api/auth/logout', cookie)).status).toBe(302)
      expect((await get('/api/auth/logout')).status).toBe(302)
      expect((await get('/api/auth/logout', 'sid=forged')).status).toBe(302)
    })

    it.each([
      ['/projects%3Fa%3D1', `/login?redirect=${encodeURIComponent('/projects?a=1')}`],
      ['//evil.com', '/login?redirect=%2F'],
      ['/%5Cevil.com', '/login?redirect=%2F'],
      ['https://evil.com', '/login?redirect=%2F'],
      ['/%09/evil.com', '/login?redirect=%2F'],
    ])('?redirect=%s → Location 是站内的 %s', async (redirect, location) => {
      const res = await get(`/api/auth/logout?redirect=${redirect}`)
      expect(res.headers.location).toBe(location)
    })
  })

  describe('GET /api/auth/config', () => {
    it('匿名可读，没有登录方式：enabled false、providers 空', async () => {
      const res = await get('/api/auth/config')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ enabled: false, providers: [] })
    })
  })

  describe('SessionPageAuth', () => {
    it('有效 → true；无 cookie / 假 token → false', async () => {
      const { cookie } = await signIn()
      const auth = app.get(SessionPageAuth)
      expect(await auth.isAuthenticated({ headers: { cookie } })).toBe(true)
      expect(await auth.isAuthenticated({ headers: {} })).toBe(false)
      expect(await auth.isAuthenticated({ headers: { cookie: 'sid=forged' } })).toBe(false)
    })
  })
}

describe('登录态端点和全局守卫（SQLite）', () => {
  behaviours(sqliteFixture)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('登录态端点和全局守卫（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(() => postgresFixture(postgresUrl as string))
})

describe('模块依赖由 Nest 解析', () => {
  it('缺 DataAccessModule → 启动时报明确的依赖解析错误，点名 DataAccess', async () => {
    await expect(bootContext([sessionConfig('file:unused.db', { secret: SECRET }), SessionModule])).rejects.toThrow(
      /can't resolve dependencies of the \w+ \(\?.*\)[\s\S]*DataAccess/,
    )
  })

  it('缺 ConfigModule → 启动时报依赖解析错误，点名 ConfigService', async () => {
    await expect(bootContext([SessionModule])).rejects.toThrow(/can't resolve dependencies[\s\S]*ConfigService/)
  })

  it('缺 SessionModule → ApiSessionGuard 启动时报依赖解析错误，不会变成不校验', async () => {
    @Module({})
    class Root {}
    await expect(
      NestFactory.create<NestFastifyApplication>(
        { module: Root, providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }] },
        new FastifyAdapter(),
        { logger: false, abortOnError: false },
      ),
    ).rejects.toThrow(/can't resolve dependencies of the ApiSessionGuard/)
  })

  it.each([
    ['data-access 在前', (a: unknown, b: unknown) => [a, b]],
    ['session 在前', (a: unknown, b: unknown) => [b, a]],
  ])('%s：启动成功，第一次查询时表已对齐', async (_name, order) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const fixture = sqliteFixture()
    const context = await bootContext([
      sessionConfig(fixture.url, { secret: SECRET }),
      ...(order(DataAccessModule, SessionModule) as never[]),
    ])
    expect(await context.get(SessionPageAuth).isAuthenticated({ headers: { cookie: 'sid=whatever' } })).toBe(false)
    await context.close()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
})

describe('safeRedirect', () => {
  it.each([
    [undefined, '/'],
    [['/a'], '/'],
    ['', '/'],
    ['x', '/'],
    ['https://evil.com', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['/\n/evil.com', '/'],
    ['/x?a=1', '/x?a=1'],
  ])('%j → %j', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected)
  })
})
