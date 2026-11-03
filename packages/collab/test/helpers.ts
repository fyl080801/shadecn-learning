import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanvasApiModule, Project } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import { nodesMap } from '@learning/contracts/flow-doc'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Module, type ModuleMetadata } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest'
import * as Y from 'yjs'
import { CollabGatewayModule } from '../src/collab-gateway.module.js'
import { CollabServer } from '../src/collab-server.js'
import { FlowPersistence } from '../src/flow-persistence.js'

export const SECRET = 'test-secret'
const HOUR = 3600 * 1000

export interface TestResponse {
  status: number
  headers: Record<string, unknown>
  text: string
  raw: Buffer
  json<T = Record<string, unknown>>(): T
}

export interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer | Uint8Array
}

/** 一个「已登录的浏览器」：带着 cookie 直接发请求，走完整的路由和全局守卫 */
export interface Actor {
  userId: string
  cookie: string
  request(url: string, init?: RequestInit): Promise<TestResponse>
  json(url: string, method: string, body?: unknown): Promise<TestResponse>
}

export interface CollabTestContext {
  readonly app: NestFastifyApplication
  readonly dataAccess: DataAccess
  readonly persistence: FlowPersistence
  readonly server: CollabServer
  /** `ws://127.0.0.1:<端口>` */
  readonly wsUrl: string
  readonly baseUrl: string
  anonymous(url: string, init?: RequestInit): Promise<TestResponse>
  actor(name?: string): Promise<Actor>
}

async function inject(app: NestFastifyApplication, url: string, init: RequestInit = {}): Promise<TestResponse> {
  const res = await app.inject({
    method: (init.method ?? 'GET') as 'GET',
    url,
    headers: init.headers,
    payload: init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body,
  })
  return { status: res.statusCode, headers: res.headers, text: res.body, raw: res.rawPayload, json: <T>() => JSON.parse(res.body) as T }
}

@Module({ providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }] })
class GuardModule {}

/** 和 `apps/platform` 的 `AppModule` 一样的接线，少了页面和登录流程。真的监听端口：upgrade 只发生在真连接上 */
export async function bootCollabApp(databaseUrl: string, options: { imports?: NonNullable<ModuleMetadata['imports']>; values?: Record<string, unknown> } = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: GuardModule,
      imports: [
        testConfigModule({ database: { url: databaseUrl }, session: { ttlSeconds: 3600 }, ...options.values }, { env: { PLATFORM_SESSION_SECRET: SECRET } }),
        DataAccessModule,
        ClusterModule,
        SessionIdentityModule,
        CanvasApiModule,
        ...(options.imports ?? [CollabGatewayModule]),
      ],
    },
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  )
  await app.listen(0, '127.0.0.1')
  return app
}

let seq = 0

export async function createActor(app: NestFastifyApplication, name = 'alice'): Promise<Actor> {
  seq += 1
  const user = await app.get(UserService).findOrCreate({
    issuer: 'https://issuer.test',
    subject: `user-${seq}-${Date.now()}`,
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
      payload === undefined ? request(url, { method }) : request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }
}

function suite(databaseUrl: string, values: Record<string, unknown>, body: (ctx: CollabTestContext) => void, afterClose: () => void, beforeClose?: () => Promise<unknown> | undefined) {
  let app: NestFastifyApplication
  let baseUrl = ''
  const ctx: CollabTestContext = {
    get app() {
      return app
    },
    get dataAccess() {
      return app.get(DataAccess)
    },
    get persistence() {
      return app.get(FlowPersistence, { strict: false })
    },
    get server() {
      return app.get(CollabServer, { strict: false })
    },
    get wsUrl() {
      return baseUrl.replace('http://', 'ws://')
    },
    get baseUrl() {
      return baseUrl
    },
    anonymous: (url, init) => inject(app, url, init),
    actor: (name) => createActor(app, name),
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app = await bootCollabApp(databaseUrl, { values })
    baseUrl = await app.getUrl()
  })

  beforeEach(async () => {
    // 欠账表在 provider 上，用例之间会串。库一清，这一轮重试只会把欠账一笔笔销掉
    await ctx.dataAccess.em().nativeDelete(Project, {})
    await ctx.persistence.retryFailed()
  })

  afterAll(async () => {
    await beforeClose?.()
    await app?.close()
    afterClose()
    vi.restoreAllMocks()
  })

  body(ctx)
}

/**
 * 同一组用例跑两种库：SQLite 临时文件 + 内存共享层；设了 `PLATFORM_TEST_DATABASE_URL` 再跑一遍 PostgreSQL。
 * PostgreSQL 用独立的 schema（`pnpm test` 里 data-access 的用例同时在重置 public），收尾时删掉。库名同时带 platform 和 test 才肯动。
 */
export function describeOnBothDatabases(name: string, body: (ctx: CollabTestContext) => void): void {
  describe(`${name}（SQLite）`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-'))
    suite(`file:${path.join(dir, 'test.db')}`, {}, body, () => fs.rmSync(dir, { recursive: true, force: true }))
  })

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  describe.skipIf(!postgresUrl)(`${name}（PostgreSQL，PLATFORM_TEST_DATABASE_URL）`, () => {
    const url = postgresUrl as string
    const schema = 'collab_test'
    let drop: (() => Promise<unknown>) | undefined
    // 同时设了 PLATFORM_TEST_REDIS_URL 就让共享层也走 Redis：awareness 归属、持有者、状态向量、配额标记都是真的跨进程结构
    const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
    suite(
      `${url}?schema=${schema}`,
      redisUrl ? { cluster: { mode: 'redis', url: redisUrl } } : {},
      (ctx) => {
        beforeAll(() => {
          assertTestDatabase(url)
          drop = () => ctx.dataAccess.orm.schema.execute(`drop schema if exists ${schema} cascade`)
        })
        body(ctx)
      },
      () => undefined,
      () => drop?.(),
    )
  })
}

export function assertTestDatabase(url: string): void {
  const database = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!/platform/.test(database) || !/test/.test(database)) {
    throw new Error(`[collab 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
  }
}

export async function createProject(owner: Actor, name = '测试项目'): Promise<string> {
  return (await owner.json('/api/projects', 'POST', { name })).json<{ id: string }>().id
}

export async function createFlow(member: Actor, projectId: string, name = '测试画布'): Promise<string> {
  return (await member.json(`/api/projects/${projectId}/flows`, 'POST', { name })).json<{ id: string }>().id
}

export async function joinViaInvite(admin: Actor, projectId: string, invitee: Actor): Promise<void> {
  const { token } = (await admin.request(`/api/projects/${projectId}/invite`)).json<{ token: string }>()
  await invitee.json(`/api/invites/${token}/accept`, 'POST')
}

/** 造一个带这些节点的文档，节点形状和前端写的一样分层 */
export function docWith(nodeIds: string[]): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of nodeIds) nodesMap(doc).set(id, nodeMap(id))
  })
  return doc
}

export function nodeMap(label = 'n'): Y.Map<unknown> {
  const node = new Y.Map<unknown>()
  node.set('position', { x: 0, y: 0 })
  const data = new Y.Map<unknown>()
  data.set('label', label)
  node.set('data', data)
  return node
}

export function addNodes(...ids: string[]): Uint8Array {
  const doc = docWith(ids)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

export function nodeIdsOf(bytes: Uint8Array | null | undefined): string[] {
  const doc = new Y.Doc()
  if (bytes && bytes.length > 0) Y.applyUpdate(doc, new Uint8Array(bytes))
  const ids = [...nodesMap(doc).keys()].sort()
  doc.destroy()
  return ids
}

export interface CloseRecord {
  code?: number
  reason?: string
}

export interface TestClient {
  provider: HocuspocusProvider
  doc: Y.Doc
  /** `onClose` 收到的每个事件。CLOSE 消息只带 reason（code 1000），真正的关闭帧才带 4xxx */
  closes: CloseRecord[]
  /** `onAuthenticationFailed` 收到的 reason：握手被拒走这条路 */
  denied: string[]
  /** 落库状态的 stateless 通知 */
  stateless: string[]
  synced(): boolean
  destroy(): void
}

/** 真的 `@hocuspocus/provider`。Node 的全局 WebSocket（undici）能带请求头，正好代替浏览器自动带的 cookie */
export function connect(wsUrl: string, room: string, cookie: string | null, options: { path?: string; doc?: Y.Doc; origin?: string } = {}): TestClient {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  if (options.origin) headers.origin = options.origin

  class CookieWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, headers } as never)
    }
  }

  const doc = options.doc ?? new Y.Doc()
  const closes: CloseRecord[] = []
  const denied: string[] = []
  const stateless: string[] = []
  let isSynced = false
  const provider = new HocuspocusProvider({
    url: `${wsUrl}${options.path ?? '/ws/collaboration'}`,
    name: room,
    document: doc,
    WebSocketPolyfill: CookieWebSocket,
    onClose: ({ event }) => closes.push({ code: event.code, reason: event.reason }),
    onAuthenticationFailed: ({ reason }) => denied.push(reason),
    onStateless: ({ payload }) => stateless.push(payload),
    onSynced: () => {
      isSynced = true
    },
    // 配置原样转给内部的 HocuspocusProviderWebsocket，只是类型上没写这一项
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  return {
    provider,
    doc,
    closes,
    denied,
    stateless,
    synced: () => isSynced,
    destroy() {
      provider.destroy()
    },
  }
}
