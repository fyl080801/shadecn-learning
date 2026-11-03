import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanvasApiModule, FlowDocStore, Project } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { CollabGatewayModule, CollabServer, FlowPersistence, roomOf } from '@learning/collab'
import { testConfigModule } from '@learning/config/testing'
import { fromYNode, nodesMap, toYNode } from '@learning/contracts/flow-doc'
import { type FlowNodeRecord } from '@learning/contracts/flow-graph'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { FlowAsset, S3_CLIENT, type S3Client, StorageModule } from '@learning/storage'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, vi } from 'vitest'
import * as Y from 'yjs'
import { AppsModule } from '../src/apps.module.js'
import { AppTask } from '../src/entities.js'
import { TASK_RUNNER_OPTIONS, TaskRunner, type TaskRunnerOptions } from '../src/task-runner.js'
import { AppTasks } from '../src/tasks.js'

export const SECRET = 'test-secret'
const HOUR = 3600 * 1000

export const CHAT_APP = 'local-llm:qwen3'
export const IMAGE_APP = 'ark:doubao-seedream-5-0-pro-260628'
export const VIDEO_APP = 'ark:doubao-seedance-2-0-260128'
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** 集成测试用的应用表（上游请求都被测试里的 fetch 截住） */
export const TEST_APPS = {
  providers: {
    'local-llm': { type: 'ollama' },
    ark: { type: 'ark', apiKey: '$TEST_APPS_ARK_KEY', pollIntervalMs: 20 },
  },
  apps: [
    { provider: 'local-llm', type: 'text', model: 'qwen3', title: '测试对话' },
    { provider: 'ark', type: 'image', model: 'doubao-seedream-5-0-pro-260628', title: '测试文生图' },
    { provider: 'ark', type: 'video', model: 'doubao-seedance-2-0-260128', title: '测试视频' },
  ],
}

export const TEST_LLM = {
  providers: {
    selfhost: {
      name: '自建端点',
      baseUrl: 'http://llm.internal/v1',
      api: 'openai-completions',
      apiKey: '$TEST_LLM_KEY',
      models: [{ id: 'qwen3', name: '千问 3' }, { id: 'qwen-vl', input: ['text', 'image'] }, { id: 'deepseek-v4.1-flash:1017-cloud' }, { id: 'vendor/model' }],
    },
  },
}

export const TEST_ENV = { PLATFORM_SESSION_SECRET: SECRET, TEST_APPS_ARK_KEY: 'ark-key', TEST_LLM_KEY: 'llm-key' }

/** 记得住对象的假 S3 */
export function fakeS3() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>()
  const client: S3Client = {
    objectUrl: (key) => `https://s3.example.test/canvas-bucket/${key}`,
    async putObject(key, body, contentType) {
      objects.set(key, { body, contentType })
      return client.objectUrl(key)
    },
    async headObject(key) {
      const found = objects.get(key)
      return found ? { size: found.body.byteLength, contentType: found.contentType } : null
    },
    async getObject(key) {
      const found = objects.get(key)
      return found ? { status: 'ok', body: found.body, contentType: found.contentType } : { status: 'not_found' }
    },
    createMultipartUpload: async () => 'x',
    uploadPart: async () => 'x',
    completeMultipartUpload: async () => 'x',
    abortMultipartUpload: async () => {},
  }
  return { client, objects }
}

export type FakeS3 = ReturnType<typeof fakeS3>

export interface BootOptions {
  databaseUrl: string
  /** 有没有协同入口：`AppModule` 的形态是 true，`PlatformBaseModule` 的形态是 false */
  gateway?: boolean
  /** 只有协同入口：`apps/collab` 的形态 */
  replica?: boolean
  values?: Record<string, unknown>
  env?: Record<string, string>
  s3?: S3Client | null
  runner?: Partial<TaskRunnerOptions>
}

/** 测试里不要启动时的那次对账和定时对账来抢时序，要测它们的用例自己调 `sweep()` 或传短的间隔 */
const QUIET_RUNNER: TaskRunnerOptions = { leaseMs: 30_000, sweepIntervalMs: 3_600_000, firstSweepMs: 3_600_000, shutdownTimeoutMs: 5_000 }

/** 和 `apps/platform` 一样的接线，少了页面和登录流程。真的监听端口：provider 要连 */
export async function bootAppsApp(options: BootOptions): Promise<NestFastifyApplication> {
  const values = { apps: TEST_APPS, llm: TEST_LLM, database: { url: options.databaseUrl }, session: { ttlSeconds: 3600 }, ...options.values }
  const builder = Test.createTestingModule({
    imports: [
      testConfigModule(values, { env: { ...TEST_ENV, ...options.env } }),
      DataAccessModule,
      ClusterModule,
      SessionIdentityModule,
      ...(options.replica ? [CollabGatewayModule] : [CanvasApiModule, ...(options.gateway === false ? [] : [CollabGatewayModule]), StorageModule, AppsModule]),
    ],
    providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
  })
  if (!options.replica) {
    builder.overrideProvider(TASK_RUNNER_OPTIONS).useValue({ ...QUIET_RUNNER, ...options.runner })
    if (options.s3 !== undefined) builder.overrideProvider(S3_CLIENT).useValue(options.s3)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false })
  await app.listen(0, '127.0.0.1')
  return app
}

export interface TestResponse {
  status: number
  text: string
  json<T = Record<string, unknown>>(): T
}

export interface Actor {
  userId: string
  cookie: string
  request(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TestResponse>
  json(url: string, method: string, body?: unknown): Promise<TestResponse>
}

async function inject(app: NestFastifyApplication, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<TestResponse> {
  const res = await app.inject({ method: (init.method ?? 'GET') as 'GET', url, headers: init.headers, payload: init.body })
  return { status: res.statusCode, text: res.body, json: <T>() => JSON.parse(res.body) as T }
}

let seq = 0

export async function createActor(app: NestFastifyApplication, name = 'alice'): Promise<Actor> {
  seq += 1
  const user = await app.get(UserService, { strict: false }).findOrCreate({ issuer: 'https://issuer.test', subject: `apps-user-${seq}-${Date.now()}`, username: name, name, email: `${name}${seq}@example.com` })
  const token = await app.get(SessionService, { strict: false }).create({
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
    json: (url, method, body) => (body === undefined ? request(url, { method }) : request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  }
}

export const anonymous = inject

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

export function nodeRecord(id: string, type: string, data: Record<string, unknown> = {}): FlowNodeRecord {
  return { id, type, layout: { position: { x: 0, y: 0 } }, metadata: { label: id }, data, runtime: { status: 'idle' } }
}

/** 往库里写画布内容（房间没开时）：走协同那条读 → 合并 → CAS */
export async function seedNodes(app: NestFastifyApplication, flowId: string, nodes: FlowNodeRecord[]): Promise<void> {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const node of nodes) nodesMap(doc).set(node.id, toYNode(node))
  })
  await app.get(FlowPersistence, { strict: false }).store(roomOf(flowId), doc, { projection: true })
  doc.destroy()
}

/** 库里的画布内容里的一个节点（服务端写回、断开连接时落库） */
export async function storedNode(app: NestFastifyApplication, flowId: string, nodeId: string): Promise<FlowNodeRecord | null> {
  const row = await app.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: false, legacy: false })
  if (!row?.ydoc) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row.ydoc))
  const node = nodesMap(doc).get(nodeId)
  const record = node instanceof Y.Map ? fromYNode(nodeId, node as Y.Map<unknown>) : null
  doc.destroy()
  return record
}

export async function until<T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`[test] 等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export const taskRow = (app: NestFastifyApplication, id: string) => app.get(AppTasks, { strict: false }).get(id)

export const taskDone = (app: NestFastifyApplication, id: string) =>
  until(async () => {
    const row = await taskRow(app, id)
    return row && !['queued', 'running'].includes(row.status) ? row : null
  }, `任务 ${id} 结束`)

export const nodeWithStatus = (app: NestFastifyApplication, flowId: string, nodeId: string, status: string) =>
  until(async () => {
    const found = await storedNode(app, flowId, nodeId)
    return found?.runtime.status === status ? found : null
  }, `节点 ${nodeId} 变成 ${status}`)

/** 往存储里放一张属于这张画布的图（和上传接口落下的一样：对象 + FlowAsset 记录） */
export async function ownAsset(app: NestFastifyApplication, s3: FakeS3, flowId: string, userId: string): Promise<string> {
  const id = randomUUID()
  const key = `canvas/assets/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.png`
  s3.objects.set(key, { body: PNG, contentType: 'image/png' })
  const em = app.get(DataAccess).em()
  em.create(FlowAsset, { key, flow: flowId, contentType: 'image/png', createdById: userId })
  await em.flush()
  return s3.client.objectUrl(key)
}

export interface ArkScript {
  /** 生图失败（上游 400） */
  imageFails?: boolean
  /** 视频任务查几次之后成功；Infinity = 一直在跑 */
  videoRunsFor?: number
  /** 生图卡住直到这个 Promise 完成 */
  imageGate?: Promise<unknown>
}

export interface UpstreamRequest {
  url: string
  method: string
  body: unknown
}

/** 脚本化的方舟上游，换掉全局 fetch。**没打桩的请求抛错**：测试不能真的连出去 */
export function arkUpstream(script: ArkScript = {}): UpstreamRequest[] {
  const requests: UpstreamRequest[] = []
  let polls = 0
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    if (url.endsWith('/images/generations')) {
      if (script.imageGate) await script.imageGate
      if (script.imageFails) return json({ error: { message: '提示词不合规' } }, 400)
      return json({ data: [{ url: 'https://ark-cdn.example/out.png', size: '2048x2048' }] })
    }
    if (url.endsWith('/contents/generations/tasks') && method === 'POST') return json({ id: 'cgt-1' })
    if (url.endsWith('/contents/generations/tasks/cgt-1')) {
      if (method === 'DELETE') return new Response(null, { status: 200 })
      polls += 1
      if (polls <= (script.videoRunsFor ?? 1)) return json({ id: 'cgt-1', status: polls === 1 ? 'queued' : 'running' })
      return json({ id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://ark-cdn.example/out.mp4', last_frame_url: 'https://ark-cdn.example/last.png' } })
    }
    if (url === 'https://ark-cdn.example/out.png' || url === 'https://ark-cdn.example/last.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    if (url === 'https://ark-cdn.example/out.mp4') return new Response(new Uint8Array([0, 0, 0, 1]), { headers: { 'content-type': 'video/mp4' } })
    throw new Error(`[test] 未打桩的出站请求：${url}`)
  })
  return requests
}

/** OpenAI 兼容的上游：一段流式回复（带思考）；记下请求 */
export function chatUpstream(content: string) {
  const requests: { url: string; authorization: string | null; body: { model: string } }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) as { model: string } })
    const chunks = [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想一想', content } }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  return requests
}

export interface SubmitResult {
  status: number
  body: Record<string, unknown>
  task: { id: string; [key: string]: unknown } | null
}

export async function submit(actor: Actor, flowId: string, appId: string, body: unknown): Promise<SubmitResult> {
  const res = await actor.json(`/api/flows/${flowId}/apps/${encodeURIComponent(appId)}/execute`, 'POST', body)
  const parsed = res.text ? res.json() : {}
  return { status: res.status, body: parsed, task: res.status === 202 ? (parsed.task as SubmitResult['task']) : null }
}

export interface TestClient {
  provider: HocuspocusProvider
  doc: Y.Doc
  stateless: string[]
  synced(): boolean
  destroy(): void
}

/** 真的 `@hocuspocus/provider`。Node 的全局 WebSocket（undici）能带请求头，正好代替浏览器自动带的 cookie */
export function connect(baseUrl: string, flowId: string, cookie: string): TestClient {
  class CookieWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, headers: { cookie } } as never)
    }
  }
  const doc = new Y.Doc()
  const stateless: string[] = []
  let isSynced = false
  const provider = new HocuspocusProvider({
    url: `${baseUrl.replace('http://', 'ws://')}/ws/collaboration`,
    name: roomOf(flowId),
    document: doc,
    WebSocketPolyfill: CookieWebSocket,
    onStateless: ({ payload }) => stateless.push(payload),
    onSynced: () => {
      isSynced = true
    },
    // 配置原样转给内部的 HocuspocusProviderWebsocket，只是类型上没写这一项
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  return { provider, doc, stateless, synced: () => isSynced, destroy: () => provider.destroy() }
}

export function assertTestDatabase(url: string): void {
  const database = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!/platform/.test(database) || !/test/.test(database)) {
    throw new Error(`[apps 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
  }
}

export interface AppsTestContext {
  readonly app: NestFastifyApplication
  readonly baseUrl: string
  readonly s3: FakeS3
  readonly runner: TaskRunner
  actor(name?: string): Promise<Actor>
}

function suite(databaseUrl: string, values: Record<string, unknown>, body: (ctx: AppsTestContext) => void, beforeClose: ((app: NestFastifyApplication) => Promise<unknown>) | undefined, afterClose: () => void) {
  let app: NestFastifyApplication
  let baseUrl = ''
  const s3 = fakeS3()
  const ctx: AppsTestContext = {
    get app() {
      return app
    },
    get baseUrl() {
      return baseUrl
    },
    s3,
    get runner() {
      return app.get(TaskRunner, { strict: false })
    },
    actor: (name) => createActor(app, name),
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app = await bootAppsApp({ databaseUrl, values, s3: s3.client })
    baseUrl = await app.getUrl()
  }, 30_000)

  beforeEach(async () => {
    s3.objects.clear()
    const em = app.get(DataAccess).em()
    await em.nativeDelete(AppTask, {})
    await em.nativeDelete(Project, {})
  })

  /** 用例留下的任务（一直在跑的视频）不能带进下一个用例；房间散场之后才换 fetch */
  afterEach(async () => {
    for (const id of ctx.runner.running()) ctx.runner.abortTask(id, 'canceled')
    await until(() => ctx.runner.running().length === 0, '任务都停下来')
    await until(() => app.get(CollabServer, { strict: false }).hocuspocus.documents.size === 0 || app.get(CollabServer, { strict: false }).hocuspocus.getConnectionsCount() === 0, '房间散场')
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    await beforeClose?.(app)
    await app?.close()
    afterClose()
    vi.restoreAllMocks()
  })

  body(ctx)
}

/**
 * 同一组用例跑两种库：SQLite 临时文件 + 内存共享层；设了 `PLATFORM_TEST_DATABASE_URL` 再跑一遍 PostgreSQL（同时设了 `PLATFORM_TEST_REDIS_URL` 共享层也走 Redis）。
 * PostgreSQL 用独立的 schema，不碰 public，收尾时删掉。库名同时带 platform 和 test 才肯动。
 */
export function describeOnBothDatabases(name: string, schema: string, body: (ctx: AppsTestContext) => void): void {
  describe(`${name}（SQLite）`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'))
    suite(`file:${path.join(dir, 'test.db')}`, {}, body, undefined, () => fs.rmSync(dir, { recursive: true, force: true }))
  })

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  describe.skipIf(!postgresUrl)(`${name}（PostgreSQL，PLATFORM_TEST_DATABASE_URL）`, () => {
    const url = postgresUrl as string
    const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
    suite(
      `${url}?schema=${schema}`,
      redisUrl ? { cluster: { mode: 'redis', url: redisUrl } } : {},
      body,
      (app) => {
        assertTestDatabase(url)
        return app.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
      },
      () => undefined,
    )
  })
}
