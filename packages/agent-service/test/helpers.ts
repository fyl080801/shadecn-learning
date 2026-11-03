import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '@learning/agent-core/session'
import { gatewayFetch, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '@learning/agent-core/testing'
import { CanvasApiModule, FlowDocStore, FlowsService, Project, ProjectsService, AccessRevocation } from '@learning/canvas'
import { ClusterModule } from '@learning/cluster'
import { CollabModule, CollabServer } from '@learning/collab'
import { testConfigModule } from '@learning/config/testing'
import { AgentEventType, type AgentStreamEvent } from '@learning/contracts/agent'
import { nodesMap } from '@learning/contracts/flow-doc'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, SessionIdentityModule, SessionService, UserService } from '@learning/session'
import { S3_CLIENT, type S3Client } from '@learning/storage'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, vi } from 'vitest'
import * as Y from 'yjs'
import { AgentModule } from '../src/agent.module.js'
import { AgentAuthorities, type AgentAuthorityOptions } from '../src/authority.js'
import { AgentCanvasAccess } from '../src/canvas-access.js'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from '../src/entities.js'
import { AGENT_HOST_OPTIONS, type AgentHostOptions } from '../src/runtime.js'
import { AgentGrants } from '../src/stores.js'

export const SECRET = 'test-secret'
const HOUR = 3600 * 1000
export const TEST_ENV = { PLATFORM_SESSION_SECRET: SECRET }

export interface BootOptions {
  databaseUrl: string
  values?: Record<string, unknown>
  env?: Record<string, string>
  s3?: S3Client | null
  dataDir?: string
  isProduction?: boolean
  /** 不 import `AgentModule`：只为看「没有这个模块的进程」的表 */
  withoutAgent?: boolean
  /** 让 `AgentModule` 离根比 `CollabModule` 远，协同的关闭钩子先跑（见上） */
  agentBelowCollab?: boolean
  override?: (builder: TestingModuleBuilder) => void
}

/*
 * Nest 关闭阶段按模块离根的距离依次跑钩子，近的先跑。距离由 import 关系的树得出（@nestjs/core 的 TopologyTree）：一个模块被更深的模块 import 时会整棵挪过去，
 * 所以平铺时 `AgentModule` 总比它 import 的 `CollabModule` 近，退出放错阶段也测不出来。但这不是保证：不挪的时候子模块可能留在别的分支上，这之后祖先再被挪深，import 方就比被 import 方还远。
 * 下面这个形状就是这样（实测 `CollabModule` 距离 4，`AgentModule` 距离 6），协同的钩子先跑：退出要在别的阶段才对，靠顺序的写法在这里露馅。
 */
@Module({ imports: [CollabModule] })
class CollabHolderInner {}
@Module({ imports: [CollabHolderInner] })
class CollabHolder {}
@Module({ imports: [AgentModule] })
class AgentHolder {}
@Module({ imports: [AgentHolder] })
class DeepInner {}
@Module({ imports: [DeepInner] })
class DeepMiddle {}
@Module({ imports: [DeepMiddle] })
class DeepOuter {}

/** 和将来 `apps/platform` 一样的接线，少了页面、登录流程和 agent 的 HTTP 入口（`docs/31` §7 第 6 步才有） */
export function agentTestModule(options: BootOptions): TestingModuleBuilder {
  const values = { database: { url: options.databaseUrl }, session: { ttlSeconds: 3600 }, ...options.values }
  const builder = Test.createTestingModule({
    imports: [
      testConfigModule(values, { env: { ...TEST_ENV, ...options.env }, ...(options.dataDir ? { dataDir: options.dataDir } : {}), ...(options.isProduction ? { isProduction: true } : {}) }),
      DataAccessModule,
      ClusterModule,
      SessionIdentityModule,
      CanvasApiModule,
      ...(options.withoutAgent ? [] : options.agentBelowCollab ? [CollabHolder, AgentHolder, DeepOuter] : [AgentModule]),
    ],
    providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }],
  })
  if (options.s3 !== undefined) builder.overrideProvider(S3_CLIENT).useValue(options.s3)
  options.override?.(builder)
  return builder
}

export async function bootAgentApp(options: BootOptions): Promise<NestFastifyApplication> {
  const moduleRef = await agentTestModule(options).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false })
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

export interface Actor {
  userId: string
  request(url: string, init?: { method?: string }): Promise<{ status: number; json<T = Record<string, unknown>>(): T }>
  json(url: string, method: string, body?: unknown): Promise<{ status: number; json<T = Record<string, unknown>>(): T }>
}

let seq = 0

export async function createActor(app: NestFastifyApplication, name = 'alice'): Promise<Actor> {
  seq += 1
  const user = await app.get(UserService, { strict: false }).findOrCreate({ issuer: 'https://issuer.test', subject: `agent-user-${seq}-${Date.now()}`, username: name, name, email: `${name}${seq}@example.com` })
  const token = await app.get(SessionService, { strict: false }).create({
    userId: user.id,
    provider: 'oidc',
    tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + HOUR), refreshExpiresAt: null, sessionState: null },
  })
  const cookie = `sid=${token}`
  const send = async (url: string, method: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) })
    return { status: res.statusCode, json: <T>() => JSON.parse(res.body) as T }
  }
  return { userId: user.id, request: (url, init = {}) => send(url, init.method ?? 'GET'), json: send }
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

/** 库里的画布节点 id（断开连接时落库） */
export async function storedNodeIds(app: NestFastifyApplication, flowId: string): Promise<string[]> {
  const row = await app.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: false, legacy: false })
  const doc = new Y.Doc()
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc))
  const ids = [...nodesMap(doc).keys()].sort()
  doc.destroy()
  return ids
}

export async function until<T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`[test] 等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一条要等外面放行才回复的模型回复；被中止时立刻收尾。`reached` 在模型被请求时兑现 */
export function gated(reply = '完成', aborted = '…') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  let calls = 0
  const step: ScriptedStep = async (_context, options) => {
    calls += 1
    reach()
    const { fauxAssistantMessage } = await import('@earendil-works/pi-ai')
    return new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage(aborted)))
      void gate.then(() => resolve(fauxAssistantMessage(reply)))
    })
  }
  return { step, release, reached, calls: () => calls }
}

export function runIdOf(events: AgentStreamEvent[]): string {
  const started = events[0]
  if (started?.type !== AgentEventType.RUN_STARTED) throw new Error('第一帧不是 RUN_STARTED')
  return started.runId
}

export type ScriptedRuntime = AgentRuntime & { scripted: ScriptedModel }

export interface AgentTestContext {
  readonly app: NestFastifyApplication
  /** 给对象存储的默认假 S3（要别的 S3 的用例自己起一个 app） */
  readonly s3: MemoryS3
  actor(name?: string): Promise<Actor>
  /** 脚本化的模型 + 生产那套宿主接线（`AGENT_HOST_OPTIONS`）+ 进程内的 runner，走完整路径：runner → 网关 → 服务端调上游 */
  useScripted(responses: ScriptedStep[], overrides?: Partial<AgentRuntimeOptions>, model?: { imageInput?: boolean }): ScriptedRuntime
  /** 相当于第 6 步的 `POST …/messages`：发起一轮，等它彻底结束，兑现这一轮的全部事件 */
  send(runtime: AgentRuntime, who: Actor, flowId: string, text: string): Promise<AgentStreamEvent[]>
  /** 生产那一份 */
  readonly authorities: AgentAuthorities
  /** 一份选项不同的判权（缓存时长、时钟），对账表是它自己的 */
  authorityWith(options: AgentAuthorityOptions): AgentAuthorities
  readonly host: AgentHostOptions
  readonly access: AgentCanvasAccess
}

/** 记得住对象的假 S3，`getObject` 记下读了哪些键，按上限回 too_large */
export function memoryS3() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>()
  const reads: string[] = []
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
    async getObject(key, { maxBytes }) {
      reads.push(key)
      const found = objects.get(key)
      if (!found) return { status: 'not_found' }
      if (found.body.byteLength > maxBytes) return { status: 'too_large' }
      return { status: 'ok', body: found.body, contentType: found.contentType }
    },
    createMultipartUpload: async () => 'u',
    uploadPart: async () => '"e"',
    completeMultipartUpload: async (key) => client.objectUrl(key),
    abortMultipartUpload: async () => {},
  }
  return { client, objects, reads }
}

export type MemoryS3 = ReturnType<typeof memoryS3>

export function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

function suite(databaseUrl: string, values: Record<string, unknown>, boot: Partial<BootOptions>, body: (ctx: AgentTestContext) => void, beforeClose: ((app: NestFastifyApplication) => Promise<unknown>) | undefined, afterClose: () => void) {
  let app: NestFastifyApplication
  const s3 = memoryS3()
  const runtimes: AgentRuntime[] = []
  const ctx: AgentTestContext = {
    get app() {
      return app
    },
    s3,
    actor: (name) => createActor(app, name),
    useScripted(responses, overrides = {}, model = {}) {
      const scripted = registerScriptedModel(model)
      scripted.setResponses(responses)
      const runtime = createAgentRuntime({ ...scripted.runtimeOptions(), ...ctx.host, ...overrides })
      runtimes.push(runtime)
      vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
      return Object.assign(runtime, { scripted })
    },
    async send(runtime, who, flowId, text) {
      const events: AgentStreamEvent[] = []
      const started = await runtime.start({
        flowId,
        userId: who.userId,
        conversationId: null,
        text,
        openCanvas: (runId, authority) => ctx.access.open({ flowId, userId: who.userId, runId, authority }),
        emit: (event) => events.push(event),
      })
      if (!started.ok) throw new Error(`[test] 应该启动成功：${started.message}`)
      await started.done
      return events
    },
    get authorities() {
      return app.get(AgentAuthorities, { strict: false })
    },
    authorityWith: (options) => new AgentAuthorities(app.get(AgentGrants, { strict: false }), app.get(FlowsService, { strict: false }), app.get(ProjectsService, { strict: false }), app.get(AccessRevocation, { strict: false }), options),
    get host() {
      return app.get<AgentHostOptions>(AGENT_HOST_OPTIONS, { strict: false })
    },
    get access() {
      return app.get(AgentCanvasAccess, { strict: false })
    },
  }

  beforeAll(async () => {
    silenceConsole()
    app = await bootAgentApp({ databaseUrl, values, s3: s3.client, ...boot })
  }, 30_000)

  beforeEach(async () => {
    s3.objects.clear()
    s3.reads.length = 0
    const em = app.get(DataAccess).em()
    await em.nativeDelete(AgentGrantScope, {})
    await em.nativeDelete(AgentGrant, {})
    await em.nativeDelete(AgentToolCall, {})
    await em.nativeDelete(AgentRun, {})
    await em.nativeDelete(AgentConversation, {})
    await em.nativeDelete(Project, {})
  })

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.abortAll('用例结束')))
    const collab = app.get(CollabServer, { strict: false })
    await until(() => collab.hocuspocus.getConnectionsCount() === 0, '房间散场')
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

export function assertTestDatabase(url: string): void {
  const database = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!/platform/.test(database) || !/test/.test(database)) throw new Error(`[agent 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
}

/** 共享层走 Redis 时的配置（设了 `PLATFORM_TEST_REDIS_URL` 才有） */
export const redisValues = (): Record<string, unknown> => (process.env.PLATFORM_TEST_REDIS_URL ? { cluster: { mode: 'redis', url: process.env.PLATFORM_TEST_REDIS_URL } } : {})

/**
 * 同一组用例跑两种库：SQLite 临时文件 + 内存共享层；设了 `PLATFORM_TEST_DATABASE_URL` 再跑一遍 PostgreSQL（同时设了 `PLATFORM_TEST_REDIS_URL` 共享层也走 Redis）。
 * PostgreSQL 用独立的 schema，不碰 public，收尾时删掉。库名同时带 platform 和 test 才肯动。
 */
export function describeOnBothDatabases(name: string, schema: string, body: (ctx: AgentTestContext) => void, boot: Partial<BootOptions> = {}): void {
  describe(`${name}（SQLite）`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'))
    suite(`file:${path.join(dir, 'test.db')}`, {}, boot, body, undefined, () => fs.rmSync(dir, { recursive: true, force: true }))
  })

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  describe.skipIf(!postgresUrl)(`${name}（PostgreSQL，PLATFORM_TEST_DATABASE_URL）`, () => {
    const url = postgresUrl as string
    suite(
      `${url}?schema=${schema}`,
      redisValues(),
      boot,
      body,
      (app) => {
        assertTestDatabase(url)
        return app.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
      },
      () => undefined,
    )
  })
}

/**
 * `process` 驱动起的是 agent-core 的 tsc 产物，没构建时 `SANDBOX_DRIVER` 就是「未启用」。
 * 产物 import 的是 contracts、llm 的 dist（Node 解析，不走 vitest 的 alias），所以先要它们。已有就不重建，不和 agent-core 自己的用例抢。
 */
export function ensureRunnerBuilt(): void {
  const packageDir = path.resolve(import.meta.dirname, '..')
  if (fs.existsSync(path.resolve(packageDir, '../agent-core/dist/runner/main.js'))) return
  const tsc = createRequire(path.join(packageDir, 'package.json')).resolve('typescript/bin/tsc')
  for (const dir of ['../contracts', '../llm', '../agent-core']) {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: path.resolve(packageDir, dir), stdio: 'pipe' })
  }
}
