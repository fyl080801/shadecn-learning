import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type ScriptedStep, startScriptedUpstream, type ScriptedUpstream } from '@learning/agent-core/testing'
import { agentApiPath, agentConversationPath, AgentEventType, agentRunEventsPath, type AgentConversationView, type AgentStreamEvent } from '@learning/contracts/agent'
import { HTTP_CLOSE_GRACE_MS } from '@learning/foundation'
import { FakeBrowser, followAuthorize, startFakeIdp, type FakeIdp } from '@learning/session/testing'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DataAccess } from '@learning/data-access'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'

/**
 * 真 SIGTERM（`docs/31` §8.2）：真启动 `apps/platform` 的产物（单进程 `dist/main.js`，拆开形态 `dist/main-without-collab.js`），`process` 驱动起真 runner，模型是测试进程里的脚本化上游。
 * 钉的是 `app.close()` 模拟不了的东西：信号走完 Nest 的关闭流程、`useProcessExit` 的退出码、hijack 的 SSE 真的结束、产物里的依赖声明和解析路径都对。
 */

const platformDir = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(platformDir, '../..')
const SECRET = 'sigterm-test-secret'
const UPSTREAM_KEY_ENV = 'SIGTERM_TEST_UPSTREAM_KEY'
/** 拆开形态的入口：根是 `PlatformSplitModule`，没有协同入口，不是 `cluster: redis` 就拒绝启动 */
const SPLIT_ENTRY = 'dist/main-without-collab.js'
/** 这些包的产物比源码旧，起来的就不是这次改的代码 */
const BUILT_PACKAGES = ['apps/platform', 'packages/agent-service', 'packages/agent-core', 'packages/foundation', 'packages/collab', 'packages/canvas', 'packages/cluster', 'packages/session', 'packages/storage', 'packages/contracts']

function newestFile(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return Math.max(0, ...fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs))
}

function ensurePlatformBuilt(): void {
  const stale = BUILT_PACKAGES.some((name) => newestFile(path.join(repoRoot, name, 'src')) > newestFile(path.join(repoRoot, name, 'dist')))
  if (stale || !fs.existsSync(path.join(platformDir, 'dist/main.js')) || !fs.existsSync(path.join(platformDir, SPLIT_ENTRY))) execFileSync('pnpm', ['--filter', '@learning/platform', 'build'], { cwd: repoRoot, stdio: 'pipe' })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function until<T>(read: () => Promise<T | false | null | undefined> | T | false | null | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface Platform {
  baseUrl: string
  child: ChildProcess
  logs: string[]
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const children = new Set<ChildProcess>()

/** 配置走真实路径：`$DATA_DIR/config.yaml` + 环境变量。环境是列出来的，开发机的 `PLATFORM_*` 进不来 */
async function startPlatform(dir: string, port: number, values: Record<string, unknown>, env: Record<string, string>, entry = 'dist/main.js'): Promise<Platform> {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({ ...values, server: { port, host: '127.0.0.1', origins: [`http://127.0.0.1:${port}`] } }))
  const child = spawn(process.execPath, [path.join(platformDir, entry)], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DATA_DIR: dir, PLATFORM_SESSION_SECRET: SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const logs: string[] = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      children.delete(child)
      resolve({ code, signal })
    }),
  )
  const baseUrl = `http://127.0.0.1:${port}`
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`平台没起来：\n${logs.join('')}`)
      return (await fetch(`${baseUrl}/api/health`).catch(() => null))?.ok
    },
    `平台启动：\n${logs.join('')}`,
    30_000,
  )
  return { baseUrl, child, logs, exited }
}

/** 登录是真的：假 IdP + 平台的回调，拿到的 cookie 跨重启还在（会话在库里） */
async function login(baseUrl: string): Promise<string> {
  const browser = new FakeBrowser(baseUrl, baseUrl)
  const start = await browser.get('/api/auth/login?provider=oidc&redirect=%2F')
  await browser.get(await followAuthorize(start.headers.location as string))
  const session = browser.cookies.get('sid')
  if (!session) throw new Error('登录没有拿到 cookie')
  return `sid=${session.value}`
}

function client(baseUrl: string, cookie: string) {
  const request = (url: string, init: RequestInit = {}) => fetch(`${baseUrl}${url}`, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } })
  return {
    request,
    json: (url: string, method: string, body?: unknown) => request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }),
  }
}

/** 边到边攒的 SSE：`ended` 在流结束时兑现，断开（不是正常结束）也算 */
function follow(res: Response) {
  const state = { raw: '', ended: false }
  const decoder = new TextDecoder()
  const ended = (async () => {
    const reader = res.body!.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        state.raw += decoder.decode(value, { stream: true })
      }
    } catch {
      // 对面断开也是结束
    }
    state.ended = true
  })()
  const events = () =>
    state.raw
      .split('\n\n')
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
  return { state, ended, events }
}

/** 第一步加一个节点，第二步卡在模型请求上，直到被叫停 */
function addNodeThenHold() {
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  let release: () => void = () => undefined
  const hold: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      reach()
      release = () => resolve(fauxAssistantMessage('放行了'))
      options.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
    })
  return { steps: [fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '收尾前写的' } })], { stopReason: 'toolUse' }), hold], reached, release: () => release() }
}

beforeAll(() => ensurePlatformBuilt(), 300_000)

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

describe('真 SIGTERM（dist/main.js，SQLite，process 驱动）', () => {
  let root: string
  let idp: FakeIdp
  let upstream: ScriptedUpstream

  const values = (dir: string) => ({
    database: { url: `file:${path.join(dir, 'platform.db')}` },
    web: { root: path.join(root, 'public') },
    auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } },
    llm: { providers: { scripted: { baseUrl: upstream.url, api: 'openai-completions', apiKey: `$${UPSTREAM_KEY_ENV}`, models: [{ id: upstream.modelId, name: '脚本模型' }] } } },
    agent: { provider: 'scripted', model: upstream.modelId, titleModel: 'off', sandbox: { driver: 'process', allowProcess: true } },
  })
  const env = () => ({ [UPSTREAM_KEY_ENV]: upstream.apiKey })

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-sigterm-'))
    fs.mkdirSync(path.join(root, 'public'))
    fs.writeFileSync(path.join(root, 'public/index.html'), 'INDEX')
    fs.writeFileSync(path.join(root, 'public/login.html'), 'LOGIN')
    idp = await startFakeIdp()
    upstream = await startScriptedUpstream()
  })

  afterAll(async () => {
    await upstream.close()
    await idp.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('运行中收到信号：5 秒内退出、退出码 0；发起者和旁观者的流都以收尾帧结束；重启后对话和节点都在', async () => {
    const dir = path.join(root, 'run')
    const port = await freePort()
    const first = await startPlatform(dir, port, values(dir), env())
    const cookie = await login(first.baseUrl)
    const api = client(first.baseUrl, cookie)
    const { id: projectId } = (await (await api.json('/api/projects', 'POST', { name: '项目' })).json()) as { id: string }
    const { id: flowId } = (await (await api.json(`/api/projects/${projectId}/flows`, 'POST', { name: '画布' })).json()) as { id: string }

    const script = addNodeThenHold()
    upstream.scripted.setResponses(script.steps)
    const res = await api.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '加一个节点' })
    expect(res.status, first.logs.join('')).toBe(200)
    const origin = follow(res)
    await script.reached
    const started = origin.events()[0] as Extract<AgentStreamEvent, { type: typeof AgentEventType.RUN_STARTED }>
    const watching = await api.request(agentRunEventsPath(flowId, started.runId))
    expect(watching.status).toBe(200)
    const watcher = follow(watching)
    await until(() => watcher.events().length > 0, '旁观者收到补发')

    const at = Date.now()
    first.child.kill('SIGTERM')
    const exit = await first.exited
    const elapsed = Date.now() - at
    expect(exit, first.logs.join('')).toEqual({ code: 0, signal: null })
    expect(elapsed, first.logs.join('')).toBeLessThan(5_000)

    await Promise.all([origin.ended, watcher.ended])
    for (const stream of [origin, watcher]) {
      expect(stream.events().at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: '服务正在重启' } })
    }
    expect(watcher.events()).toEqual(origin.events())
    // 上游的请求被掐断，runner 的工作目录清掉了
    await until(() => !fs.readdirSync(path.join(dir, 'agent-workspaces'), { recursive: true, encoding: 'utf8' }).some((entry) => entry.includes('run_')), '工作目录清掉')

    const second = await startPlatform(dir, port, values(dir), env())
    const reopened = client(second.baseUrl, cookie)
    const conversation = (await (await reopened.request(agentConversationPath(flowId, started.threadId))).json()) as AgentConversationView
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(conversation.messages[0]).toMatchObject({ text: '加一个节点' })
    expect(await (await reopened.request(`/api/flows/${flowId}`)).json()).toMatchObject({ nodeCount: 1 })
    expect(await (await reopened.request(agentApiPath(flowId))).json()).toMatchObject({ enabled: true, running: false, activeRuns: [] })

    second.child.kill('SIGTERM')
    expect(await second.exited).toEqual({ code: 0, signal: null })
  }, 90_000)

  it('一个字节都没发的连接（浏览器预连接）不挡退出：最多多等一个 HTTP 关闭的上限', async () => {
    const dir = path.join(root, 'silent')
    const port = await freePort()
    const platform = await startPlatform(dir, port, values(dir), env())
    const silent = net.connect(port, '127.0.0.1')
    silent.on('error', () => undefined)
    await new Promise((resolve) => silent.once('connect', resolve))

    const at = Date.now()
    platform.child.kill('SIGTERM')
    expect(await platform.exited, platform.logs.join('')).toEqual({ code: 0, signal: null })
    expect(Date.now() - at).toBeLessThan(HTTP_CLOSE_GRACE_MS + 3_000)
    silent.destroy()
  }, 60_000)
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

describe.skipIf(!postgresUrl || !redisUrl)('真 SIGTERM（两个进程，dist/main-without-collab.js，PostgreSQL + Redis）', () => {
  const SCHEMA = 'platform_sigterm'
  let root: string
  let idp: FakeIdp
  let upstream: ScriptedUpstream

  const values = (holder: boolean) => ({
    database: { url: `${postgresUrl}?schema=${SCHEMA}`, schemaSync: holder ? 'apply' : 'off' },
    cluster: { mode: 'redis', url: redisUrl },
    web: { root: path.join(root, 'public') },
    auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } },
    llm: { providers: { scripted: { baseUrl: upstream.url, api: 'openai-completions', apiKey: `$${UPSTREAM_KEY_ENV}`, models: [{ id: upstream.modelId, name: '脚本模型' }] } } },
    agent: { provider: 'scripted', model: upstream.modelId, titleModel: 'off', sandbox: { driver: 'process', allowProcess: true } },
  })
  const env = () => ({ [UPSTREAM_KEY_ENV]: upstream.apiKey })

  beforeAll(async () => {
    const database = decodeURIComponent(new URL(postgresUrl as string).pathname.slice(1))
    if (!/platform/.test(database) || !/test/.test(database)) throw new Error(`库名必须同时带 platform 和 test，收到的是 ${database}`)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-sigterm-pg-'))
    fs.mkdirSync(path.join(root, 'public'))
    fs.writeFileSync(path.join(root, 'public/index.html'), 'INDEX')
    fs.writeFileSync(path.join(root, 'public/login.html'), 'LOGIN')
    idp = await startFakeIdp()
    upstream = await startScriptedUpstream()
  })

  afterAll(async () => {
    await upstream.close()
    await idp.stop()
    // 这个 schema 是这个文件自己建的，走应用的连接删掉
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DATA_DIR', root)
    vi.stubEnv('PLATFORM_SESSION_SECRET', SECRET)
    vi.stubEnv('PLATFORM_DATABASE_URL', '')
    vi.stubEnv('PLATFORM_REDIS_URL', '')
    fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({ database: { url: `${postgresUrl}?schema=${SCHEMA}`, schemaSync: 'off' }, web: { root: path.join(root, 'public') } }))
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false, abortOnError: false })
    await app.init()
    await app.get(DataAccess).orm.schema.execute(`drop schema if exists ${SCHEMA} cascade`)
    await app.close()
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('跟着别的副本上那一轮的进程收到信号：很快退出、退出码 0，流结束；这一轮不受影响，持有者退出时另一边照样收到收尾帧', async () => {
    const holderDir = path.join(root, 'holder')
    const followerDir = path.join(root, 'follower')
    const holder = await startPlatform(holderDir, await freePort(), values(true), env(), SPLIT_ENTRY)
    const follower = await startPlatform(followerDir, await freePort(), values(false), env(), SPLIT_ENTRY)
    const cookie = await login(holder.baseUrl)
    const onHolder = client(holder.baseUrl, cookie)
    const onFollower = client(follower.baseUrl, cookie)
    const { id: projectId } = (await (await onHolder.json('/api/projects', 'POST', { name: '项目' })).json()) as { id: string }
    const { id: flowId } = (await (await onHolder.json(`/api/projects/${projectId}/flows`, 'POST', { name: '画布' })).json()) as { id: string }

    const script = addNodeThenHold()
    upstream.scripted.setResponses(script.steps)
    const res = await onHolder.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '加一个节点' })
    expect(res.status).toBe(200)
    const origin = follow(res)
    await script.reached
    const { runId } = origin.events()[0] as Extract<AgentStreamEvent, { type: typeof AgentEventType.RUN_STARTED }>

    // 这条流的循环卡在 SharedLog.wait 上，abortAll 碰不到（这一轮不在本进程），Cluster 又在 HTTP 关闭之后才关
    const stuck = await onFollower.request(agentRunEventsPath(flowId, runId))
    expect(stuck.status, follower.logs.join('')).toBe(200)
    const stuckStream = follow(stuck)
    await until(() => stuckStream.events().length > 0, '跨副本补发')
    const second = await onFollower.request(agentRunEventsPath(flowId, runId))
    const secondStream = follow(second)
    await until(() => secondStream.events().length > 0, '跨副本补发（第二条）')

    const at = Date.now()
    follower.child.kill('SIGTERM')
    const exit = await follower.exited
    expect(exit, follower.logs.join('')).toEqual({ code: 0, signal: null })
    expect(Date.now() - at, follower.logs.join('')).toBeLessThan(5_000)
    await Promise.all([stuckStream.ended, secondStream.ended])
    // 跟着的人走了，这一轮还在：不是它的退出能中止的
    expect(origin.state.ended).toBe(false)
    expect(((await (await onHolder.request(agentApiPath(flowId))).json()) as { running: boolean }).running).toBe(true)

    // 持有者退出：另一个进程上新接回的流收到收尾帧
    const replica = await startPlatform(followerDir, await freePort(), values(false), env(), SPLIT_ENTRY)
    const onReplica = client(replica.baseUrl, cookie)
    const watching = await onReplica.request(agentRunEventsPath(flowId, runId))
    expect(watching.status).toBe(200)
    const watcher = follow(watching)
    await until(() => watcher.events().length > 0, '重新接回')
    const holderAt = Date.now()
    holder.child.kill('SIGTERM')
    expect(await holder.exited, holder.logs.join('')).toEqual({ code: 0, signal: null })
    expect(Date.now() - holderAt, holder.logs.join('')).toBeLessThan(5_000)
    await Promise.all([origin.ended, watcher.ended])
    for (const stream of [origin, watcher]) {
      expect(stream.events().at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: '服务正在重启' } })
    }
    // 另一个进程上看：这一轮结束了，已写的内容在库里
    expect(await (await onReplica.request(agentApiPath(flowId))).json()).toMatchObject({ running: false, activeRuns: [] })
    expect(await (await onReplica.request(`/api/flows/${flowId}`)).json()).toMatchObject({ nodeCount: 1 })

    replica.child.kill('SIGTERM')
    expect(await replica.exited, replica.logs.join('')).toEqual({ code: 0, signal: null })
  }, 120_000)
})
