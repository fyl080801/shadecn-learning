import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AgentRuntime, StartRunInput, StartRunResult } from '@learning/agent-core/session'
import { CollabServer } from '@learning/collab'
import { agentApiPath, agentRunEventsPath, AgentEventType, type AgentStreamEvent } from '@learning/contracts/agent'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCanvasAccess } from '../src/canvas-access.js'
import { AGENT_RUNTIME } from '../src/sandbox.js'
import { SSE_CLOSE_GRACE_MS, SSE_HEARTBEAT_MS } from '../src/sse.js'
import { bootAgentApp, createHttpActor, createHttpFlow, createHttpProject, type HttpActor, parseSse, realFetch, silenceConsole, type SwitchableRuntime, until } from './helpers.js'

/**
 * 面板 SSE 这条路自己的约束，运行时是假的（编排层的行为在 `routes.test.ts`）：心跳；退出时谁来结束流（`docs/31` §8.2）；退出期间不放行新的一轮。
 * 退出的用例每个起一个 app，因为要关掉它。真 SIGTERM 在 `apps/platform/test/agent-sigterm.test.ts`。
 */

const finished = { type: AgentEventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'success' }, timestamp: 1 } as unknown as AgentStreamEvent

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sse-'))
beforeAll(() => silenceConsole())
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

let app: NestFastifyApplication
let baseUrl: string
let alice: HttpActor
let flowId: string
let runtime: SwitchableRuntime
let closed = false

beforeEach(async () => {
  app = await bootAgentApp({ databaseUrl: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}`, s3: null, http: true })
  baseUrl = await app.getUrl()
  closed = false
  alice = await createHttpActor(app, baseUrl)
  flowId = await createHttpFlow(alice, await createHttpProject(alice))
  runtime = app.get<SwitchableRuntime>(AGENT_RUNTIME, { strict: false })
})

afterEach(async () => {
  vi.useRealTimers()
  if (!closed) await app.close()
})

const closeApp = () => {
  closed = true
  return app.close()
}

/** 跟着一轮的订阅：`done` 永远不兑现，和跟着别的副本上那一轮、卡在 `SharedLog.wait` 上的一样，只有退订才结束 */
function foreverSubscription(frames: AgentStreamEvent[] = []) {
  const unsubscribe = vi.fn()
  const fake = {
    ...runtime,
    subscribe: async (_flowId: string, _runId: string, onEvent: (event: AgentStreamEvent) => void) => {
      for (const frame of frames) onEvent(frame)
      return { ok: true as const, done: new Promise<void>(() => undefined), unsubscribe }
    },
  } as AgentRuntime
  runtime.use(fake)
  return { unsubscribe }
}

describe('心跳', () => {
  it(`没有事件时每 ${SSE_HEARTBEAT_MS} 毫秒发一行注释，解析器看不见它；断开后不再发，也退订`, async () => {
    const { unsubscribe } = foreverSubscription([finished])
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const res = await alice.request(agentRunEventsPath(flowId, 'run_x'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let raw = decoder.decode((await reader.read()).value)
    expect(parseSse(raw)).toEqual([finished])
    expect(raw).not.toContain(': ping')

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS)
    raw = decoder.decode((await reader.read()).value)
    expect(raw).toBe(': ping\n\n')
    expect(parseSse(raw)).toEqual([])

    expect(unsubscribe).not.toHaveBeenCalled()
    await reader.cancel()
    await until(() => unsubscribe.mock.calls.length > 0, '断开后退订')
  })
})

describe('开流', () => {
  it('还没有任何帧时响应头就到了：前端靠它知道这一轮开始了', async () => {
    foreverSubscription([])
    const res = await Promise.race([alice.request(agentRunEventsPath(flowId, 'run_x')), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))])
    expect(res?.status).toBe(200)
    await res?.body?.cancel()
  })
})

describe('开流之前客户端就断开了', () => {
  it('subscribe 还没返回时断开：close 事件已经过去了，照样退订，不挂到这一轮结束', async () => {
    const unsubscribe = vi.fn()
    let reached!: () => void
    const subscribing = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    runtime.use({
      ...runtime,
      subscribe: async () => {
        reached()
        await gate
        return { ok: true as const, done: new Promise<void>(() => undefined), unsubscribe }
      },
    } as AgentRuntime)

    const url = new URL(`${baseUrl}${agentRunEventsPath(flowId, 'run_x')}`)
    const socket = net.connect(Number(url.port), url.hostname)
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${alice.cookie}\r\n\r\n`)
    await subscribing
    const gone = new Promise((resolve) => socket.once('close', resolve))
    socket.destroy()
    await gone
    // 让服务端先看到断开，再放行 subscribe
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()

    await until(() => unsubscribe.mock.calls.length > 0, '已经断开的连接要退订')
  })
})

describe('退出时结束流', () => {
  it('跟着别的副本上那一轮的订阅：app.close() 照样返回，退订了，客户端看到流结束', async () => {
    const { unsubscribe } = foreverSubscription([finished])
    const res = await alice.request(agentRunEventsPath(flowId, 'run_x'))
    const text = res.text()

    const startedAt = Date.now()
    await closeApp()
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(unsubscribe).toHaveBeenCalled()
    expect(parseSse(await text)).toEqual([finished])
  }, 15_000)

  it('还没结束的网关请求：退出时断开，不等 HTTP 关闭的上限', async () => {
    runtime.use({
      ...runtime,
      gateway: { handle: async () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('data: x\n\n')) }), { headers: { 'content-type': 'text/event-stream' } }) },
    } as AgentRuntime)
    const res = await realFetch(`${baseUrl}/api/agent-gateway/model/main/api/stream`, { method: 'POST' })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()
    const broken = reader.read().then(
      () => 'ended',
      () => 'broken',
    )

    const startedAt = Date.now()
    await closeApp()
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(await broken).toBe('broken')
  }, 15_000)

  it('客户端不读了、收尾帧写不出去：等到上限就往下走，不挡退出', async () => {
    // 一帧足够大，操作系统的缓冲放不下，响应结束不了
    const huge = { type: AgentEventType.CUSTOM, name: 'x', value: 'x'.repeat(64 * 1024 * 1024), timestamp: 1 } as unknown as AgentStreamEvent
    foreverSubscription([huge])
    const { hostname, port } = new URL(baseUrl)
    const socket = net.connect(Number(port), hostname)
    socket.on('error', () => undefined)
    socket.pause()
    socket.write(`GET ${agentRunEventsPath(flowId, 'run_x')} HTTP/1.1\r\nHost: x\r\nCookie: ${alice.cookie}\r\n\r\n`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const startedAt = Date.now()
    await closeApp()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(SSE_CLOSE_GRACE_MS - 100)
    expect(elapsed).toBeLessThan(SSE_CLOSE_GRACE_MS + 3_000)
    socket.destroy()
  }, 15_000)

  it('收口之后才开的流（subscribe 比收口慢）：发完已有的帧就结束，不挂上去', async () => {
    const unsubscribe = vi.fn()
    let answer!: () => void
    const answering = new Promise<void>((resolve) => (answer = resolve))
    let arrived!: () => void
    const arrival = new Promise<void>((resolve) => (arrived = resolve))
    runtime.use({
      ...runtime,
      subscribe: async (_flowId: string, _runId: string, onEvent: (event: AgentStreamEvent) => void) => {
        arrived()
        await answering
        onEvent(finished)
        return { ok: true as const, done: new Promise<void>(() => undefined), unsubscribe }
      },
    } as AgentRuntime)
    const pending = alice.request(agentRunEventsPath(flowId, 'run_x'))
    await arrival
    const closing = closeApp()
    await new Promise((resolve) => setTimeout(resolve, 100))
    answer()
    const res = await pending
    expect(parseSse(await res.text())).toEqual([finished])
    expect(unsubscribe).toHaveBeenCalled()
    await closing
  }, 15_000)
})

describe('退出期间', () => {
  /** 把关闭停在 `abortAll` 上：这一段 HTTP 还开着，是要守的窗口 */
  function holdShutdown() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const entered = new Promise<void>((resolve) => (reached = resolve))
    const started: StartRunInput[] = []
    const fake = {
      ...runtime,
      enabled: true,
      disabledReason: null,
      start: (input: StartRunInput) => {
        started.push(input)
        return Promise.resolve({ ok: true, runId: 'r', done: Promise.resolve(), unsubscribe: () => undefined } satisfies StartRunResult)
      },
      subscribe: () => Promise.reject(new Error('不该订阅')),
      abortAll: () => {
        reached()
        return gate
      },
    } as unknown as AgentRuntime
    runtime.use(fake)
    return { release, entered, started }
  }

  it('新的一轮和新的接回都 503，不碰编排层；别的只读接口照常', async () => {
    const { release, entered, started } = holdShutdown()
    const closing = closeApp()
    await entered

    const refused = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '再来一轮' })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'Service Unavailable', message: '服务正在重启，请稍后再试' })
    expect(started).toEqual([])
    expect((await alice.request(agentRunEventsPath(flowId, 'run_x'))).status).toBe(503)
    expect((await alice.request(`${agentApiPath(flowId)}/conversations`)).status).toBe(200)

    release()
    await closing
  }, 15_000)

  it('判断在 start() 紧前面：退出前进来、卡在查节点上的请求，走到这里同样 503', async () => {
    const { release, entered, started } = holdShutdown()
    let answer!: (value: boolean) => void
    let checking!: () => void
    const checked = new Promise<void>((resolve) => (checking = resolve))
    vi.spyOn(app.get(AgentCanvasAccess, { strict: false }), 'flowHasNode').mockImplementation(() => {
      checking()
      return new Promise((resolve) => (answer = resolve))
    })
    const pending = alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好', nodeId: 'n_1' })
    await checked

    const closing = closeApp()
    await entered
    answer(true)
    expect((await pending).status).toBe(503)
    expect(started).toEqual([])

    release()
    await closing
  }, 15_000)

  it('start() 还没返回的（在共享层占槽位）：退出要等它收尾，不能漏掉', async () => {
    let settle!: (result: StartRunResult) => void
    let starting!: () => void
    const inStart = new Promise<void>((resolve) => (starting = resolve))
    runtime.use({
      ...runtime,
      enabled: true,
      disabledReason: null,
      start: () => {
        starting()
        return new Promise<StartRunResult>((resolve) => (settle = resolve))
      },
      abortAll: () => Promise.resolve(),
    } as unknown as AgentRuntime)
    const pending = alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })
    await inStart

    // 协同关房间的钩子：要排在这一轮收尾之后。不能看 app.close() 返回了没有，这个请求还开着，HTTP 本来就要等它
    const collabClosing = vi.spyOn(app.get(CollabServer, { strict: false }), 'beforeApplicationShutdown')
    const closing = closeApp()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(collabClosing).not.toHaveBeenCalled()

    settle({ ok: true, runId: 'r', done: Promise.resolve(), unsubscribe: () => undefined })
    await closing
    expect(collabClosing).toHaveBeenCalled()
    expect((await pending).status).toBe(200)
  }, 15_000)
})
