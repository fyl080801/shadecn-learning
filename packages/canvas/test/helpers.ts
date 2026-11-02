import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClusterModule } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { Module, type ModuleMetadata } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest'
import { CanvasApiModule } from '../src/canvas-api.module.js'
import { Project } from '../src/entities.js'

/** 分享链接按请求的 Host 拼，这个地址在白名单里 */
export const ORIGIN = 'http://127.0.0.1:3000'
const HOST = '127.0.0.1:3000'

export interface TestResponse {
  status: number
  headers: Record<string, unknown>
  text: string
  json<T = Record<string, unknown>>(): T
}

/** 一个「已登录的浏览器」：带着 cookie 直接发请求，走完整的路由和全局守卫 */
export interface Actor {
  userId: string
  cookie: string
  request(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TestResponse>
  /** 没有 body 时不带 content-type，和前端的 `request()` 一样 */
  json(path: string, method: string, body?: unknown): Promise<TestResponse>
}

export interface CanvasTestContext {
  readonly app: NestFastifyApplication
  readonly dataAccess: DataAccess
  /** 不带 cookie */
  anonymous(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TestResponse>
  actor(name?: string): Promise<Actor>
}

async function inject(
  app: NestFastifyApplication,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  const res = await app.inject({
    method: (init.method ?? 'GET') as 'GET',
    url,
    headers: { host: HOST, ...init.headers },
    payload: init.body,
  })
  return { status: res.statusCode, headers: res.headers, text: res.body, json: <T>() => JSON.parse(res.body) as T }
}

const SECRET = 'test-secret'
const HOUR = 3600 * 1000

@Module({ providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }] })
class GuardModule {}

/** 和 `apps/platform` 的 `AppModule` 一样的接线，少了页面和登录流程 */
export async function bootCanvasApp(databaseUrl: string, extra: NonNullable<ModuleMetadata['imports']> = []): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: GuardModule,
      imports: [
        testConfigModule(
          { database: { url: databaseUrl }, session: { ttlSeconds: 3600 }, server: { origins: [ORIGIN] } },
          { env: { PLATFORM_SESSION_SECRET: SECRET } },
        ),
        DataAccessModule,
        ClusterModule,
        SessionIdentityModule,
        CanvasApiModule,
        ...extra,
      ],
    },
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  )
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

let seq = 0

/**
 * 同一组用例跑两种库：SQLite 临时文件；设了 `PLATFORM_TEST_DATABASE_URL` 再跑一遍 PostgreSQL。
 * PostgreSQL 用独立的 schema，不碰 public（`pnpm test` 里 data-access 的用例同时在重置 public），收尾时删掉。库名同时带 platform 和 test 才肯动。
 */
export function describeOnBothDatabases(name: string, body: (ctx: CanvasTestContext) => void): void {
  describe(`${name}（SQLite）`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-'))
    suite(`file:${path.join(dir, 'test.db')}`, body, () => {
      fs.rmSync(dir, { recursive: true, force: true })
      return Promise.resolve()
    })
  })

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  describe.skipIf(!postgresUrl)(`${name}（PostgreSQL，PLATFORM_TEST_DATABASE_URL）`, () => {
    const url = postgresUrl as string
    const schema = 'canvas_test'
    let drop: (() => Promise<unknown>) | undefined
    suite(
      `${url}?schema=${schema}`,
      (ctx) => {
        beforeAll(() => {
          const database = decodeURIComponent(new URL(url).pathname.slice(1))
          if (!/platform/.test(database) || !/test/.test(database)) {
            throw new Error(`[canvas 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
          }
          drop = () => ctx.dataAccess.orm.schema.execute(`drop schema if exists ${schema} cascade`)
        })
        body(ctx)
      },
      () => Promise.resolve(),
      () => drop?.(),
    )
  })
}

function suite(databaseUrl: string, body: (ctx: CanvasTestContext) => void, afterClose: () => Promise<void>, beforeClose?: () => Promise<unknown> | undefined) {
  let app: NestFastifyApplication
  const ctx: CanvasTestContext = {
    get app() {
      return app
    },
    get dataAccess() {
      return app.get(DataAccess)
    },
    anonymous: (url, init) => inject(app, url, init),
    async actor(name = 'alice') {
      seq += 1
      const user = await app.get(UserService).findOrCreate({
        issuer: 'https://issuer.test',
        subject: `user-${seq}`,
        username: name,
        name,
        email: `${name}${seq}@example.com`,
      })
      const token = await app.get(SessionService).create({
        userId: user.id,
        provider: 'oidc',
        tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + HOUR), refreshExpiresAt: null, sessionState: null },
      })
      const cookie = `sid=${token}`
      const request: Actor['request'] = (url, init = {}) => inject(app, url, { ...init, headers: { ...init.headers, cookie } })
      return {
        userId: user.id,
        cookie,
        request,
        json: (url, method, payload) =>
          payload === undefined
            ? request(url, { method })
            : request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      }
    },
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    app = await bootCanvasApp(databaseUrl)
  })

  beforeEach(async () => {
    // 项目级联带走成员、邀请、画布、个人状态
    await ctx.dataAccess.em().nativeDelete(Project, {})
  })

  afterAll(async () => {
    await beforeClose?.()
    await app?.close()
    await afterClose()
    vi.restoreAllMocks()
  })

  body(ctx)
}

/** 建项目，返回 id */
export async function createProject(owner: Actor, name = '测试项目'): Promise<string> {
  return (await owner.json('/api/projects', 'POST', { name })).json<{ id: string }>().id
}

/** 建画布，返回 id */
export async function createFlow(member: Actor, projectId: string, name = '测试画布'): Promise<string> {
  return (await member.json(`/api/projects/${projectId}/flows`, 'POST', { name })).json<{ id: string }>().id
}

/** 取项目的分享链接 token（没有就由服务端当场建一条） */
export async function shareToken(admin: Actor, projectId: string): Promise<string> {
  return (await admin.request(`/api/projects/${projectId}/invite`)).json<{ token: string }>().token
}

/** 让 invitee 通过项目的分享链接加入 */
export async function joinViaInvite(admin: Actor, projectId: string, invitee: Actor): Promise<string> {
  const token = await shareToken(admin, projectId)
  await invitee.json(`/api/invites/${token}/accept`, 'POST')
  return token
}
