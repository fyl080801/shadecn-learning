import 'reflect-metadata'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Cluster } from '@learning/cluster'
import { CollabGatewayModule, CollabServer } from '@learning/collab'
import { DataAccess } from '@learning/data-access'
import { bootstrapService } from '@learning/foundation'
import { SessionService, UserService } from '@learning/session'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { AppModule } from '../src/app.module.js'
import { PlatformBaseModule } from '../src/platform-base.module.js'
import { PlatformSplitModule } from '../src/platform-split.module.js'

const SECRET_PAGE = 'PROTECTED-INDEX'
const LOGIN_PAGE = 'LOGIN-ENTRY'
const ASSET = 'console.log("asset")'

function staticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-static-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), SECRET_PAGE)
  fs.writeFileSync(path.join(dir, 'login.html'), LOGIN_PAGE)
  fs.writeFileSync(path.join(dir, 'assets/a.js'), ASSET)
  fs.writeFileSync(path.join(dir, 'vite.svg'), '<svg/>')
  return dir
}

/**
 * 走真实的配置路径：写 `$DATA_DIR/config.yaml`，由 ConfigModule 在启动时读。
 * JSON 就是合法的 YAML，这里用不着 yaml 依赖。
 */
function writeConfig(dataDir: string, values: Record<string, unknown>) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATA_DIR', dataDir)
  vi.stubEnv('PLATFORM_SESSION_SECRET', 'test-secret')
  vi.stubEnv('PLATFORM_DATABASE_URL', '')
  vi.stubEnv('PLATFORM_REDIS_URL', '')
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), JSON.stringify(values))
}

const productionConfig = (env: { url: string; dir: string }) => ({
  database: { url: env.url },
  web: { root: env.dir },
})

async function listen(moduleDefinition: Parameters<typeof NestFactory.create>[0]) {
  const app = await NestFactory.create<NestFastifyApplication>(moduleDefinition, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  })
  await app.listen(0, '127.0.0.1')
  return { app, baseUrl: await app.getUrl() }
}

function rawRequest(baseUrl: string, target: string, cookie?: string) {
  const { hostname, port } = new URL(baseUrl)
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    // URL 里的 IPv6 地址带方括号（默认监听 localhost 时是 [::1]），http.request 不认
    const host = hostname.replace(/^\[|\]$/g, '')
    const req = http.request({ hostname: host, port, path: target, headers: cookie ? { cookie } : {} }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 库的差异只在连接串 */
function behaviours(createUrl: (dir: string) => string, cleanup?: (app: NestFastifyApplication) => Promise<void>) {
  let dir: string
  let app: NestFastifyApplication
  let baseUrl: string
  let cookie: string
  let token: string
  const get = (target: string, withCookie?: string) => rawRequest(baseUrl, target, withCookie)

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dir = staticDir()
    writeConfig(dir, productionConfig({ url: createUrl(dir), dir }))
    ;({ app, baseUrl } = await listen(AppModule))
    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'alice' })
    token = await app.get(SessionService).create({
      userId: user.id,
      provider: 'keycloak',
      tokens: {
        accessToken: 'access-token-value',
        refreshToken: null,
        idToken: null,
        expiresAt: new Date(Date.now() + 3600_000),
        refreshExpiresAt: null,
        sessionState: null,
      },
    })
    cookie = `sid=${token}`
  })

  afterAll(async () => {
    await cleanup?.(app)
    await app.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['/', '/login?redirect=%2F'],
    ['/projects?a=1', `/login?redirect=${encodeURIComponent('/projects?a=1')}`],
    ['/index.html', `/login?redirect=${encodeURIComponent('/index.html')}`],
  ])('匿名页面 %s → 302 到登录页，拿不到受保护的 HTML', async (target, location) => {
    const res = await get(target)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(location)
    expect(res.body).not.toContain(SECRET_PAGE)
  })

  it('匿名可以取登录页、js 资源、公开文件；公开文件不存在时是 404', async () => {
    expect((await get('/login')).body).toBe(LOGIN_PAGE)
    expect((await get('/assets/a.js')).body).toBe(ASSET)
    expect((await get('/vite.svg')).status).toBe(200)
    const favicon = await get('/favicon.ico')
    expect(favicon.status).toBe(404)
    expect(favicon.body).not.toContain(SECRET_PAGE)
  })

  it('匿名 API：me / config 200，其他 /api 路径 401', async () => {
    expect(JSON.parse((await get('/api/auth/me')).body)).toEqual({ enabled: true, authenticated: false, user: null })
    expect(JSON.parse((await get('/api/auth/config')).body)).toEqual({ enabled: false, providers: [] })
    expect((await get('/api/none')).status).toBe(401)
  })

  it('登录后：页面 200，/login 跳走（站内校验），me 没有 token 字段，未知 API 是 JSON 404', async () => {
    const page = await get('/', cookie)
    expect(page.status).toBe(200)
    expect(page.body).toBe(SECRET_PAGE)
    expect((await get('/index.html', cookie)).body).toBe(SECRET_PAGE)

    expect((await get('/login?redirect=/x', cookie)).headers.location).toBe('/x')
    expect((await get('/login?redirect=//evil.com', cookie)).headers.location).toBe('/')

    const me = await get('/api/auth/me', cookie)
    expect(JSON.parse(me.body)).toMatchObject({ enabled: true, authenticated: true, user: { subject: 'alice' } })
    expect(me.body).not.toContain('access-token-value')
    expect(me.body).not.toContain(token)

    const missing = await get('/api/none', cookie)
    expect(missing.status).toBe(404)
    expect(missing.headers['content-type']).toContain('application/json')
  })

  it('画布 REST 接进来了：匿名 401；登录后建项目、建画布、看列表，个人空间懒创建', async () => {
    expect((await get('/api/projects')).status).toBe(401)

    const send = (method: string, target: string, body: unknown) =>
      app.inject({ method: method as 'POST', url: target, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) })
    const project = await send('POST', '/api/projects', { name: '项目' })
    expect(project.statusCode).toBe(201)
    const { id } = project.json<{ id: string }>()
    expect((await send('POST', `/api/projects/${id}/flows`, { name: '画布' })).statusCode).toBe(201)

    expect(JSON.parse((await get('/api/projects', cookie)).body).total).toBeGreaterThan(0)
    expect(JSON.parse((await get(`/api/projects/${id}/flows`, cookie)).body).total).toBe(1)
    expect(JSON.parse((await get('/api/projects/personal', cookie)).body).kind).toBe('personal')
  })

  it('上传接进来了：匿名 401；没配对象存储时服务照常跑，成员 503，别的画布 404', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/flows/nope/assets' })).statusCode).toBe(401)
    const send = (target: string, body: unknown) =>
      app.inject({ method: 'POST', url: target, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) })
    const { id: projectId } = (await send('/api/projects', { name: '上传项目' })).json<{ id: string }>()
    const { id: flowId } = (await send(`/api/projects/${projectId}/flows`, { name: '上传画布' })).json<{ id: string }>()

    const multipart = (target: string) =>
      app.inject({ method: 'POST', url: target, headers: { cookie, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' })
    expect((await multipart(`/api/flows/${flowId}/assets`)).statusCode).toBe(503)
    expect((await multipart('/api/flows/nope/assets')).statusCode).toBe(404)
    expect((await send(`/api/flows/${flowId}/assets/variants`, { src: 'x' })).statusCode).toBe(503)
  })

  it('个人画布的二进制保存接进来了：和上传共用 octet-stream 的解析器，两边都收得到字节，别的路径 415', async () => {
    const personal = JSON.parse((await get('/api/projects/personal', cookie)).body) as { id: string }
    const send = (target: string, body: unknown) => app.inject({ method: 'POST', url: target, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) })
    const { id: flowId } = (await send(`/api/projects/${personal.id}/flows`, { name: '个人画布' })).json<{ id: string }>()
    const doc = new Y.Doc()
    doc.getMap('nodes').set('n1', new Y.Map())
    const binary = (target: string, payload: Buffer) => app.inject({ method: 'POST', url: target, headers: { cookie, 'content-type': 'application/octet-stream' }, payload })
    const saved = await binary(`/api/flows/${flowId}/doc`, Buffer.from(Y.encodeStateAsUpdate(doc)))
    expect(saved.statusCode, saved.body).toBe(200)
    // 分片上传经 octet-stream 走到控制器（没配对象存储 503），不是解析器的 415
    expect((await binary(`/api/flows/${flowId}/assets/multipart/u1/parts/1?key=x`, Buffer.from('x'))).statusCode).not.toBe(415)
    expect((await binary('/api/projects', Buffer.from('x'))).statusCode).toBe(415)
  })

  it('应用接进来了：匿名 401；没配应用时服务照常跑，列表和任务都是空的，提交 404', async () => {
    expect((await get('/api/apps')).status).toBe(401)
    expect(JSON.parse((await get('/api/apps', cookie)).body)).toEqual([])
    const send = (target: string, body: unknown) => app.inject({ method: 'POST', url: target, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) })
    const { id: projectId } = (await send('/api/projects', { name: '应用项目' })).json<{ id: string }>()
    const { id: flowId } = (await send(`/api/projects/${projectId}/flows`, { name: '应用画布' })).json<{ id: string }>()
    expect(JSON.parse((await get(`/api/flows/${flowId}/apps/tasks`, cookie)).body)).toMatchObject({ tasks: [] })
    expect((await get('/api/flows/nope/apps/tasks', cookie)).status).toBe(404)
    expect((await send(`/api/flows/${flowId}/apps/${encodeURIComponent('a:b')}/execute`, { params: {}, nodeId: 'n' })).statusCode).toBe(404)
  })

  it('协同接进来了：监控接口要登录，/ws/collaboration 真的走 upgrade，跨站握手 403', async () => {
    expect((await get('/api/collab/rooms')).status).toBe(401)
    expect(JSON.parse((await get('/api/collab/rooms', cookie)).body)).toMatchObject({ totalRooms: 0 })
    expect((await get('/api/collab/health', cookie)).status).toBe(200)

    const handshake = (headers: Record<string, string>) => {
      const { hostname, port } = new URL(baseUrl)
      return new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: hostname.replace(/^\[|\]$/g, ''),
          port,
          path: '/ws/collaboration',
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
        })
        req.on('upgrade', (res, socket) => {
          socket.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.on('response', (res) => {
          res.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
    }
    expect(await handshake({})).toBe(101)
    expect(await handshake({ origin: 'https://evil.example' })).toBe(403)
  })

  it('登出之后回到匿名状态', async () => {
    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'bob' })
    const other = `sid=${await app.get(SessionService).create({
      userId: user.id,
      provider: 'keycloak',
      tokens: {
        accessToken: 'x',
        refreshToken: null,
        idToken: null,
        expiresAt: new Date(Date.now() + 3600_000),
        refreshExpiresAt: null,
        sessionState: null,
      },
    })}`
    expect((await get('/', other)).status).toBe(200)
    expect((await get('/api/auth/logout', other)).headers.location).toBe('/login')
    expect((await get('/', other)).status).toBe(302)
  })
}

describe('AppModule（生产配置，SQLite）', () => {
  behaviours((dir) => `file:${path.join(dir, 'test.db')}`)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
const POSTGRES_SCHEMA = 'platform_app_test'

describe.skipIf(!postgresUrl)('AppModule（生产配置，PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(
    () => {
      const url = postgresUrl as string
      // 这个 schema 收尾时会被删；库名不对就不动，防止手滑指到别人的库
      const database = decodeURIComponent(new URL(url).pathname.slice(1))
      if (!/platform/.test(database) || !/test/.test(database)) throw new Error(`库名必须同时带 platform 和 test，收到的是 ${database}`)
      return `${url}?schema=${POSTGRES_SCHEMA}`
    },
    async (app) => {
      await app.get(DataAccess).orm.schema.execute(`drop schema if exists ${POSTGRES_SCHEMA} cascade`)
    },
  )
})

describe('模块依赖和 imports 顺序无关', () => {
  let dir: string

  beforeEach(() => {
    dir = staticDir()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 根模块的 imports 是 [config, data-access, session, page-auth, web, …]。全排 120 种没必要：全局模块之间的先后只看前后关系，
  // 三个有依赖的业务模块排全，config（谁都依赖它）和 page-auth（web 要它）放在最前和最后各试一次
  it.each([
    ['config, page-auth, data-access, session, web', [0, 3, 1, 2, 4]],
    ['config, page-auth, data-access, web, session', [0, 3, 1, 4, 2]],
    ['config, page-auth, session, data-access, web', [0, 3, 2, 1, 4]],
    ['config, page-auth, session, web, data-access', [0, 3, 2, 4, 1]],
    ['config, page-auth, web, data-access, session', [0, 3, 4, 1, 2]],
    ['config, page-auth, web, session, data-access', [0, 3, 4, 2, 1]],
    ['web, session, data-access, page-auth, config', [4, 2, 1, 3, 0]],
    ['page-auth, web, data-access, session, config', [3, 4, 1, 2, 0]],
  ])('%s：启动成功，全新的库上第一次校验页面时表已对齐，且只同步一次', async (_name, order) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    writeConfig(dir, productionConfig({ url: `file:${path.join(dir, 'order.db')}`, dir }))
    const imports = [...(Reflect.getMetadata('imports', PlatformBaseModule) as unknown[]), CollabGatewayModule]
    const providers = Reflect.getMetadata('providers', PlatformBaseModule) as unknown[]
    expect(imports).toHaveLength(11)

    @Module({})
    class ReorderedRoot {}
    const { app, baseUrl } = await listen({
      module: ReorderedRoot,
      // 排列之外的六个（cluster、它的检查、画布 REST、存储、应用、协同）放在最前面，也是一种「先后无关」
      imports: [imports[5], imports[6], imports[7], imports[8], imports[9], imports[10], ...order.map((index) => imports[index])],
      providers,
    } as never)

    // 带 cookie 才会真的查 session 表：表不在就是 500，在就是「查无此会话」的 302
    const res = await rawRequest(baseUrl, '/', 'sid=not-a-real-session')
    expect(res.status).toBe(302)

    const synced = log.mock.calls.filter((call) => String(call[0]).includes('[data-access] 已同步表结构'))
    expect(synced).toHaveLength(1)
    await app.close()
  })
})

describe('config.yaml', () => {
  let dir: string

  beforeEach(() => {
    dir = staticDir()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const url = () => `file:${path.join(dir, 'config.db')}`

  it('AppModule 的 imports 全是静态模块：没有 forRoot，配置收在各模块里', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[]
    expect(imports.every((item) => typeof item === 'function')).toBe(true)
  })

  it('生产环境 PLATFORM_SESSION_SECRET 缺失 → 启动失败', async () => {
    writeConfig(dir, { database: { url: url() }, web: { root: dir } })
    vi.stubEnv('PLATFORM_SESSION_SECRET', '')
    await expect(listen(AppModule)).rejects.toThrow('PLATFORM_SESSION_SECRET')
  })

  it('配置文件语法错 → 启动失败，错误带路径，不带内容', async () => {
    writeConfig(dir, {})
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'session:\n  secret: hunter2-secret\n  list: [1\n')
    const failure = listen(AppModule)
    await expect(failure).rejects.toThrow(path.join(dir, 'config.yaml'))
    await expect(failure).rejects.not.toThrow('hunter2')
  })

  it('不读 DATABASE_URL 和旧的 STATIC_DIR：库默认在 $DATA_DIR/platform.db，root 走 web.root', async () => {
    const elsewhere = path.join(dir, 'elsewhere.db')
    writeConfig(dir, { web: { root: dir } })
    vi.stubEnv('DATABASE_URL', `file:${elsewhere}`)
    vi.stubEnv('STATIC_DIR', path.join(dir, 'no-such-dir'))
    const { app, baseUrl } = await listen(AppModule)
    expect((await rawRequest(baseUrl, '/login')).body).toBe(LOGIN_PAGE)
    expect(fs.existsSync(path.join(dir, 'platform.db'))).toBe(true)
    expect(fs.existsSync(elsewhere)).toBe(false)
    await app.close()
  })

  it('没写 web.auth：页面闸门开着；web.auth: false 才放行页面，/api 照样 401', async () => {
    writeConfig(dir, productionConfig({ url: url(), dir }))
    const gated = await listen(AppModule)
    expect((await rawRequest(gated.baseUrl, '/')).status).toBe(302)
    await gated.app.close()

    writeConfig(dir, { ...productionConfig({ url: url(), dir }), web: { root: dir, auth: false } })
    const open = await listen(AppModule)
    expect((await rawRequest(open.baseUrl, '/')).body).toBe(SECRET_PAGE)
    expect((await rawRequest(open.baseUrl, '/api/none')).status).toBe(401)
    await open.app.close()
  })

  it('示例配置：去掉注释的部分是合法配置，启动得起来（库路径和 root 换成临时目录）', async () => {
    const example = fs.readFileSync(path.resolve(import.meta.dirname, '../config.example.yaml'), 'utf8')
    writeConfig(dir, {})
    const patched = example
      .replace('# url: file:data/platform.db', `url: ${JSON.stringify(url())}`)
      .replace('# root: output/public', `root: ${JSON.stringify(dir)}`)
    fs.writeFileSync(path.join(dir, 'config.yaml'), patched)
    const { app, baseUrl } = await listen(AppModule)
    expect((await rawRequest(baseUrl, '/')).status).toBe(302)
    expect((await rawRequest(baseUrl, '/api/none')).status).toBe(401)
    await app.close()
  })
})

describe('bootstrapService + AppModule（main.ts 的启动路径）', () => {
  let dir: string
  let app: NestFastifyApplication

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dir = staticDir()
    writeConfig(dir, { ...productionConfig({ url: `file:${path.join(dir, 'boot.db')}`, dir }), server: { port: 0 } })
    app = await bootstrapService(AppModule, { name: 'platform', nest: { logger: false, abortOnError: false } })
  })
  afterAll(async () => {
    await app.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('/api/health 匿名 200：ApiSessionGuard 和页面闸门都不插手，也不会落到 HTML 回退', async () => {
    const res = await rawRequest(await app.getUrl(), '/api/health')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' })
    expect(res.body).not.toContain(SECRET_PAGE)
  })

  it('/api/health/ready 没配 readiness：明确的 404，不是登录拦截的 401', async () => {
    const res = await rawRequest(await app.getUrl(), '/api/health/ready')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ statusCode: 404 })
  })

  it('配了 main.ts 那样的 readiness：匿名 200，库和共享层都查', async () => {
    const dir2 = staticDir()
    writeConfig(dir2, { ...productionConfig({ url: `file:${path.join(dir2, 'ready.db')}`, dir: dir2 }), server: { port: 0 } })
    const ready = await bootstrapService(AppModule, {
      name: 'platform',
      nest: { logger: false, abortOnError: false },
      readiness: (ctx) => ({
        database: () => ctx.get(DataAccess).orm.isConnected(),
        cluster: () => ctx.get(Cluster).health().ok,
      }),
    })
    const res = await rawRequest(await ready.getUrl(), '/api/health/ready')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'ready', database: 'ok', cluster: 'ok' })
    await ready.close()
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it('/api/health 之外的 /api 照样要登录，子路径也不算公开', async () => {
    const baseUrl = await app.getUrl()
    expect((await rawRequest(baseUrl, '/api/health/x')).status).toBe(401)
    expect((await rawRequest(baseUrl, '/api/none')).status).toBe(401)
    expect(JSON.parse((await rawRequest(baseUrl, '/api/auth/me')).body)).toEqual({ enabled: true, authenticated: false, user: null })
  })
})

describe('cluster + 数据库的组合', () => {
  let dir: string
  const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

  beforeEach(() => {
    dir = staticDir()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('默认 single：SQLite 照常启动', async () => {
    writeConfig(dir, productionConfig({ url: `file:${path.join(dir, 'single.db')}`, dir }))
    const { app, baseUrl } = await listen(AppModule)
    expect((await rawRequest(baseUrl, '/api/none')).status).toBe(401)
    await app.close()
  })

  it('cluster.mode 写错 → 启动失败', async () => {
    writeConfig(dir, { ...productionConfig({ url: `file:${path.join(dir, 'x.db')}`, dir }), cluster: { mode: 'nope' } })
    await expect(listen(AppModule)).rejects.toThrow('cluster.mode')
  })

  it.skipIf(!redisUrl)('生产环境 redis + SQLite → 拒绝启动', async () => {
    writeConfig(dir, { ...productionConfig({ url: `file:${path.join(dir, 'x.db')}`, dir }), cluster: { url: redisUrl } })
    await expect(listen(AppModule)).rejects.toThrow('生产环境拒绝启动')
  })

  it('database.schemaSync 写错 → 启动失败', async () => {
    writeConfig(dir, {
      database: { url: `file:${path.join(dir, 'x.db')}`, schemaSync: 'nope' },
      web: { root: dir },
    })
    await expect(listen(AppModule)).rejects.toThrow('database.schemaSync')
  })
})

describe('协同由副本提供时的根模块', () => {
  let dir: string

  beforeEach(() => {
    dir = staticDir()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('两个根模块只差协同入口：AppModule = PlatformBaseModule + CollabGatewayModule', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toEqual([PlatformBaseModule, CollabGatewayModule])
    expect(Reflect.getMetadata('imports', PlatformBaseModule)).not.toContain(CollabGatewayModule)
  })

  it('拆分入口是 single → 拒绝启动：不然房间和副本不通，生成结果到不了用户，也不报错', async () => {
    writeConfig(dir, productionConfig({ url: `file:${path.join(dir, 'split.db')}`, dir }))
    await expect(listen(PlatformSplitModule)).rejects.toThrow('cluster.mode 必须是 redis')
  })

  it.skipIf(!process.env.PLATFORM_TEST_REDIS_URL || !process.env.PLATFORM_TEST_DATABASE_URL)('拆分入口是 redis → 正常启动，就是 PlatformBaseModule 的内容', async () => {
    writeConfig(dir, { ...productionConfig({ url: process.env.PLATFORM_TEST_DATABASE_URL as string, dir }), cluster: { mode: 'redis', url: process.env.PLATFORM_TEST_REDIS_URL } })
    const { app, baseUrl } = await listen(PlatformSplitModule)
    expect((await rawRequest(baseUrl, '/api/none')).status).toBe(401)
    expect((http.Server.prototype.listenerCount.call(app.getHttpServer(), 'upgrade'))).toBe(0)
    await app.close()
  })

  it('PlatformBaseModule 能单独启动：页面和画布 REST 都在，协同的接口不存在', async () => {
    writeConfig(dir, productionConfig({ url: `file:${path.join(dir, 'base.db')}`, dir }))
    const { app, baseUrl } = await listen(PlatformBaseModule)
    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: 'base-user' })
    const cookie = `sid=${await app.get(SessionService).create({
      userId: user.id,
      provider: 'keycloak',
      tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
    })}`

    expect((await rawRequest(baseUrl, '/', cookie)).body).toBe(SECRET_PAGE)
    expect(JSON.parse((await rawRequest(baseUrl, '/api/projects/personal', cookie)).body).kind).toBe('personal')
    expect((await rawRequest(baseUrl, '/api/collab/rooms', cookie)).status).toBe(404)
    expect((await rawRequest(baseUrl, '/api/collab/health', cookie)).status).toBe(404)
    // 生成任务归平台：这个根模块里有 Hocuspocus（结果要写进房间），但没有 WebSocket 入口
    expect((http.Server.prototype.listenerCount.call(app.getHttpServer(), 'upgrade'))).toBe(0)
    expect(JSON.parse((await rawRequest(baseUrl, '/api/apps', cookie)).body)).toEqual([])
    expect(app.get(CollabServer, { strict: false }).hocuspocus.documents.size).toBe(0)
    // 上传归平台，不归协同副本：这个根模块里就有
    expect((await app.inject({ method: 'POST', url: '/api/flows/nope/assets/variants', headers: { cookie, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404)
    await app.close()
  })
})

describe('依赖边界', () => {
  it('platform 不依赖、不 import @shadecn/*', () => {
    const appDir = path.resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])

    const srcDir = path.join(appDir, 'src')
    for (const file of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts')) continue
      expect(fs.readFileSync(path.join(srcDir, file), 'utf8'), file).not.toMatch(/from '@shadecn\//)
    }
  })
})
