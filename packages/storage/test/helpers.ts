import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanvasApiModule, Project } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest'
import type { S3Client } from '../src/s3.js'
import { S3_CLIENT } from '../src/s3-client.provider.js'
import { StorageModule } from '../src/storage.module.js'

const HOST = '127.0.0.1:3000'
const SECRET = 'test-secret'
const HOUR = 3600 * 1000

export interface TestResponse {
  status: number
  text: string
  json<T = Record<string, unknown>>(): T
}

export interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string | NodeJS.ReadableStream
}

/** 一个「已登录的浏览器」：带着 cookie 发请求，走完整的路由和全局守卫 */
export interface Actor {
  userId: string
  request(url: string, init?: RequestInit): Promise<TestResponse>
  json(url: string, method: string, body?: unknown): Promise<TestResponse>
  /** 和浏览器一样：multipart，边界写进 content-type */
  upload(url: string, file: File): Promise<TestResponse>
}

/** 把 FormData 编码成浏览器发出来的样子。app.inject 收的是字节，编码交给 Node 自带的实现 */
export async function encodeForm(form: FormData): Promise<{ headers: Record<string, string>; body: Buffer }> {
  const encoded = new Response(form)
  return { headers: { 'content-type': encoded.headers.get('content-type') as string }, body: Buffer.from(await encoded.arrayBuffer()) }
}

/** 一个记得住东西的假 S3：对象、进行中的分片上传。整个 suite 共用一个实例，`reset()` 清状态 */
export function fakeS3() {
  const objects = new Map<string, { size: number; contentType: string }>()
  /** 一次传完的对象连字节一起记下：补缩略图要读回原图 */
  const bytes = new Map<string, Uint8Array>()
  const reads: string[] = []
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, number> }>()
  const aborted: string[] = []
  let seq = 0

  const client: S3Client = {
    objectUrl: (key) => `https://s3.example.test/canvas-bucket/${key}`,
    async putObject(key, body, contentType) {
      objects.set(key, { size: body.byteLength, contentType })
      bytes.set(key, body)
      return client.objectUrl(key)
    },
    async headObject(key) {
      return objects.get(key) ?? null
    },
    // 上传接口只在补缩略图、分片上传完成后读回原图
    async getObject(key) {
      reads.push(key)
      const body = bytes.get(key)
      const meta = objects.get(key)
      return body && meta ? { status: 'ok', body, contentType: meta.contentType } : { status: 'not_found' }
    },
    async createMultipartUpload(key, contentType) {
      seq += 1
      const uploadId = `up+${seq}/=`
      uploads.set(uploadId, { key, contentType, parts: new Map() })
      return uploadId
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload')
      upload.parts.set(partNumber, body.byteLength)
      return `"etag-${partNumber}"`
    },
    async completeMultipartUpload(key, uploadId, parts) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload')
      const size = parts.reduce((sum, p) => sum + (upload.parts.get(p.partNumber) ?? 0), 0)
      objects.set(key, { size, contentType: upload.contentType })
      uploads.delete(uploadId)
      return client.objectUrl(key)
    },
    async abortMultipartUpload(key, uploadId) {
      aborted.push(`${key}|${uploadId}`)
      uploads.delete(uploadId)
    },
  }
  return {
    client,
    objects,
    bytes,
    reads,
    uploads,
    aborted,
    reset() {
      objects.clear()
      bytes.clear()
      uploads.clear()
      reads.length = 0
      aborted.length = 0
    },
  }
}

export type FakeS3 = ReturnType<typeof fakeS3>

export interface BootOptions {
  databaseUrl: string
  storage?: Record<string, unknown>
  env?: Record<string, string>
  /** 换掉 S3 客户端。不给 = 走配置（真实路径） */
  s3?: S3Client
}

/** 和 `apps/platform` 的 `PlatformBaseModule` 一样的接线，少了页面和登录流程 */
export async function bootStorageApp(options: BootOptions): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({
    imports: [
      testConfigModule(
        { database: { url: options.databaseUrl }, session: { ttlSeconds: 3600 }, server: { origins: [`http://${HOST}`] }, storage: options.storage },
        { env: { PLATFORM_SESSION_SECRET: SECRET, ...options.env } },
      ),
      DataAccessModule,
      ClusterModule,
      SessionIdentityModule,
      CanvasApiModule,
      StorageModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
  })
  if (options.s3) builder.overrideProvider(S3_CLIENT).useValue(options.s3)
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false })
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

let seq = 0

async function inject(app: NestFastifyApplication, url: string, init: RequestInit = {}): Promise<TestResponse> {
  const res = await app.inject({
    method: (init.method ?? 'GET') as 'GET',
    url,
    headers: { host: HOST, ...init.headers },
    payload: init.body as string,
  })
  return { status: res.statusCode, text: res.body, json: <T>() => JSON.parse(res.body) as T }
}

export async function actorOf(app: NestFastifyApplication, name = 'alice'): Promise<Actor> {
  seq += 1
  const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject: `storage-user-${seq}`, username: name, name, email: `${name}${seq}@example.com` })
  const token = await app.get(SessionService).create({
    userId: user.id,
    provider: 'oidc',
    tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + HOUR), refreshExpiresAt: null, sessionState: null },
  })
  const cookie = `sid=${token}`
  const request: Actor['request'] = (url, init = {}) => inject(app, url, { ...init, headers: { ...init.headers, cookie } })
  return {
    userId: user.id,
    request,
    json: (url, method, body) =>
      body === undefined ? request(url, { method }) : request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    async upload(url, file) {
      const form = new FormData()
      form.set('file', file, file.name)
      return request(url, { method: 'POST', ...(await encodeForm(form)) })
    },
  }
}

export interface StorageTestContext {
  readonly app: NestFastifyApplication
  readonly dataAccess: DataAccess
  readonly s3: FakeS3
  anonymous(url: string, init?: RequestInit): Promise<TestResponse>
  actor(name?: string): Promise<Actor>
}

/**
 * 同一组用例跑两种库：SQLite 临时文件；设了 `PLATFORM_TEST_DATABASE_URL` 再跑一遍 PostgreSQL。
 * PostgreSQL 用独立的 schema，不碰 public，收尾时删掉。库名同时带 platform 和 test 才肯动。
 */
export function describeOnBothDatabases(name: string, body: (ctx: StorageTestContext) => void): void {
  describe(`${name}（SQLite）`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'))
    suite(`file:${path.join(dir, 'test.db')}`, body, undefined, () => fs.rmSync(dir, { recursive: true, force: true }))
  })

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  describe.skipIf(!postgresUrl)(`${name}（PostgreSQL，PLATFORM_TEST_DATABASE_URL）`, () => {
    const url = postgresUrl as string
    const schema = 'storage_test'
    suite(
      `${url}?schema=${schema}`,
      body,
      (app) => {
        const database = decodeURIComponent(new URL(url).pathname.slice(1))
        if (!/platform/.test(database) || !/test/.test(database)) {
          throw new Error(`[storage 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
        }
        return app.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
      },
      () => undefined,
    )
  })
}

function suite(
  databaseUrl: string,
  body: (ctx: StorageTestContext) => void,
  beforeClose: ((app: NestFastifyApplication) => Promise<unknown>) | undefined,
  afterClose: () => void,
) {
  let app: NestFastifyApplication
  const s3 = fakeS3()
  const ctx: StorageTestContext = {
    get app() {
      return app
    },
    get dataAccess() {
      return app.get(DataAccess)
    },
    s3,
    anonymous: (url, init) => inject(app, url, init),
    actor: (name) => actorOf(app, name),
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    app = await bootStorageApp({ databaseUrl, s3: s3.client })
  })

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    s3.reset()
    // 项目级联带走成员、画布、上传记录
    await ctx.dataAccess.em().nativeDelete(Project, {})
  })

  afterAll(async () => {
    await beforeClose?.(app)
    await app?.close()
    afterClose()
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

/** 让 invitee 通过项目的分享链接加入 */
export async function joinViaInvite(admin: Actor, projectId: string, invitee: Actor): Promise<void> {
  const { token } = (await admin.request(`/api/projects/${projectId}/invite`)).json<{ token: string }>()
  await invitee.json(`/api/invites/${token}/accept`, 'POST')
}
