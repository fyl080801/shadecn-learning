import net from 'node:net'
import { setImmediate as nextTick } from 'node:timers/promises'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { AGENT_GATEWAY_PATH, RUNNER_PROTOCOL_VERSION, type RunnerInput, type StsTokenResponse } from '@learning/agent-core/protocol'
import type { AgentRuntimeOptions } from '@learning/agent-core/session'
import { createInlineDriver, SCRIPTED_API_KEY, SCRIPTED_UPSTREAM_URL, type ScriptedStep } from '@learning/agent-core/testing'
import { agentApiPath, AgentEventType } from '@learning/contracts/agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpFlow as createFlow, createHttpProject as createProject, describeOnBothDatabases, parseSse, realFetch, until } from './helpers.js'

/**
 * 网关的挂载（docs/22 §4、docs/31 §4.3）：`/api/agent-gateway/*` 在会话守卫之外，只认 run 短令牌，浏览器的会话 cookie 在这里换不来任何东西；bootstrap token 兑换一次即废；换到的令牌只在这一轮活着的时候有效；交给 runner 的输入里没有真实的 key 和上游地址。
 * 还有这个挂载自己的约束：请求体直通（4MB 上限归网关，别的路由不受影响）、响应的背压和取消。前半段从 `apps/server/test/routes/agent-gateway.test.ts` 移植。
 */

type SandboxDriver = AgentRuntimeOptions['driver']

const GATEWAY_401 = { error: 'unauthorized', message: '令牌无效、已过期，或这一轮已经结束' }
const MB = 1024 * 1024

describeOnBothDatabases('网关', 'agent_gateway', (ctx) => {
const actor = (name?: string) => ctx.httpActor(name)

function gateway(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  return realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(init.body ?? {}),
  })
}

describe('网关的挂载', () => {
  it('在登录闸之外：没登录也到得了网关（回网关自己的 401，不是「需要登录」）；带着浏览器的会话 cookie 一样 401', async () => {
    ctx.useScripted([fauxAssistantMessage('x')])
    const anonymous = await gateway('/run/input')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual(GATEWAY_401)

    const alice = await actor()
    const withCookie = await gateway('/run/input', { headers: { cookie: alice.cookie } })
    expect(withCookie.status).toBe(401)
    expect(await withCookie.json()).toEqual(GATEWAY_401)
    // 模型请求同理：会话 cookie 不是令牌（开流之前的拒绝是 streamProxy 认的 `{ error: string }`）
    const model = await gateway('/model/main/api/stream', { headers: { cookie: alice.cookie }, body: { context: { messages: [] } } })
    expect(model.status).toBe(401)
    expect(await model.json()).toEqual({ error: GATEWAY_401.message })
  })

  it('bootstrap token 只能兑换一次：被抢先兑换后 runner 换不到令牌，这一轮 RUN_ERROR；抢到的令牌拿不到真实 key，这一轮结束后 401', async () => {
    let stolen: StsTokenResponse | null = null
    let input: RunnerInput | null = null
    const inline = createInlineDriver()
    // 在 runner 之前把 bootstrap token 兑换掉（模拟凭证被别人截走）
    const thief: SandboxDriver = {
      name: 'thief',
      reap: async () => {},
      async start(spec) {
        const redeemed = await gateway('/sts/token', { body: { grantType: 'bootstrap', bootstrapToken: spec.credential.token, protocolVersion: RUNNER_PROTOCOL_VERSION } })
        expect(redeemed.status).toBe(200)
        stolen = (await redeemed.json()) as StsTokenResponse
        const read = await gateway('/run/input', { headers: { authorization: `Bearer ${stolen.token}` } })
        expect(read.status).toBe(200)
        input = (await read.json()) as RunnerInput
        return inline.start(spec)
      },
    }
    ctx.useScripted([fauxAssistantMessage('不该走到这里')], { driver: thief })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })
    const events = parseSse(await res.text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR, code: 'runner_failed' })

    // runner 拿到的输入：模型描述、技能（runner 按注册表展开成工具）；没有真实 key、没有上游地址；
    // 第 7 版起也没有提示词、系统提示、之前几轮的上下文（模型请求只用服务端的 transcript）
    expect(input!).not.toHaveProperty('prompt')
    expect(input!).not.toHaveProperty('systemPrompt')
    expect(input!).not.toHaveProperty('llmMessages')
    expect(JSON.stringify(input)).not.toContain('你好')
    expect(input!.entry.skills.loaded).toEqual(['canvas', 'agents'])
    expect(input!.entry.model).not.toHaveProperty('baseUrl')
    expect(JSON.stringify(input)).not.toContain(SCRIPTED_API_KEY)
    expect(JSON.stringify(input)).not.toContain(SCRIPTED_UPSTREAM_URL)

    // 这一轮结束了：抢到的令牌就此作废
    const after = await gateway('/run/input', { headers: { authorization: `Bearer ${stolen!.token}` } })
    expect(after.status).toBe(401)
  })
})

describe('runner 协议版本不一致（镜像没重建）', () => {
  const MISMATCH_TEXT = (runner: string) =>
    `沙箱 runner 的协议版本 ${runner} 和服务端的 ${RUNNER_PROTOCOL_VERSION} 不一致，请重建沙箱镜像（pnpm build:agent-runner-image）`

  /** 用一个报告指定版本的 runner 跑一轮；返回这一轮的 SSE 帧和服务端的 warn 日志 */
  async function runWith(driverOptions: { protocolVersion: number | null }) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ctx.useScripted([fauxAssistantMessage('不该走到这里')], { driver: createInlineDriver(driverOptions) })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })
    return { events: parseSse(await res.text()), warnings: warn.mock.calls.map((call) => String(call[0])), flowId }
  }

  afterEach(() => vi.restoreAllMocks())

  it('runner 版本对不上：这一轮以 RUN_ERROR runner_protocol_mismatch 收尾，消息写明双方版本和重建办法，服务端打 warn', async () => {
    const { events, warnings } = await runWith({ protocolVersion: RUNNER_PROTOCOL_VERSION + 1 })
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_ERROR,
      code: 'runner_protocol_mismatch',
      message: MISMATCH_TEXT(String(RUNNER_PROTOCOL_VERSION + 1)),
    })
    expect(warnings.some((line) => line.includes('[agent]') && line.includes('不一致') && line.includes('pnpm build:agent-runner-image'))).toBe(true)
  })

  it('老镜像（请求里没有版本字段）同样拒绝，消息里写「未声明」', async () => {
    const { events } = await runWith({ protocolVersion: null })
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_ERROR,
      code: 'runner_protocol_mismatch',
      message: MISMATCH_TEXT('未声明（镜像过旧）'),
    })
  })

  it('版本对的 runner 不受影响（对照）', async () => {
    ctx.useScripted([fauxAssistantMessage('好的')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const events = parseSse(await (await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
  })
})

describe('请求体：直通，上限归网关，别的路由不受影响', () => {
  const big = (size: number) => JSON.stringify({ grantType: 'bootstrap', pad: 'x'.repeat(size) })
  const post = (body: string, headers: Record<string, string>) => realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/sts/token`, { method: 'POST', headers, body })

  it('2MB 的请求体到得了网关（超过 Fastify 默认的 1MB）；超过 4MB → 413，不靠 content-length', async () => {
    const accepted = await post(big(2 * MB), { 'content-type': 'application/json' })
    expect(accepted.status).toBe(400)
    expect(await accepted.json()).toMatchObject({ message: '换令牌的请求不对' })

    expect((await post(big(5 * MB), { 'content-type': 'application/json' })).status).toBe(413)
    // 分块编码，没有 content-length：边读边数
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big(5 * MB)))
        controller.close()
      },
    })
    const counted = await realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/sts/token`, { method: 'POST', body: chunked, duplex: 'half' } as RequestInit)
    expect(counted.status).toBe(413)
    // 超限之后连接还能用：请求体剩下的被丢掉了，同一个 keep-alive 连接上的下一个请求不会卡住
    for (let index = 0; index < 8; index += 1) expect((await post('{}', { 'content-type': 'application/json' })).status).toBe(400)
  })

  it('什么 content-type 都交给网关：不是 415', async () => {
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await post('{', { 'content-type': 'application/octet-stream' })).status).toBe(400)
    // 没有 content-type 也一样
    const none = await realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/sts/token`, { method: 'POST', body: new TextEncoder().encode('{}') })
    expect(none.status).toBe(400)
    // 只接受 POST 是网关自己说的
    expect((await realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/run/input`)).status).toBe(405)
  })

  it('别的路由不受影响：坏 JSON 400、超过 1MB 413、不认识的类型 415；面板接口要登录', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const messages = (body: string, type: string) => alice.request(`${agentApiPath(flowId)}/messages`, { method: 'POST', headers: { 'content-type': type }, body })

    const bad = await messages('{', 'application/json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '请求体不是合法 JSON' })
    // Fastify 看了 content-length 就回 413，不读请求体，真 socket 上 fetch 可能还在发就被断开，所以这条走 inject
    expect((await ctx.app.inject({ method: 'POST', url: `${agentApiPath(flowId)}/messages`, headers: { cookie: alice.cookie, 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'x'.repeat(2 * MB) }) })).statusCode).toBe(413)
    expect((await messages('<a/>', 'application/xml')).status).toBe(415)
    expect((await alice.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
    // 面板接口匿名 401：网关不过守卫，别的路由照样过
    expect((await realFetch(`${ctx.baseUrl}${agentApiPath(flowId)}`)).status).toBe(401)
  })
})

describe('响应：背压和取消', () => {
  /** 一个源源不断的网关响应：记下读走了多少、有没有被取消。总量有上限：背压坏了的时候用例要能失败，不能把内存吃光 */
  function endless() {
    const state = { pulled: 0, cancelled: false }
    const chunk = new Uint8Array(64 * 1024)
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await nextTick()
        if (state.pulled >= 256 * MB) {
          controller.close()
          return
        }
        state.pulled += chunk.byteLength
        controller.enqueue(chunk)
      },
      cancel() {
        state.cancelled = true
      },
    }, { highWaterMark: 0 })
    return { state, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }
  }

  /** 发了请求就不读：操作系统的缓冲填满后服务端写不进去 */
  function stalledClient() {
    const { hostname, port } = new URL(ctx.baseUrl)
    const socket = net.connect(Number(port), hostname)
    socket.pause()
    socket.write(`POST ${AGENT_GATEWAY_PATH}/model/main/api/stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n`)
    return socket
  }

  it('客户端不读就不再从上游读，读了才接着读；断开时取消响应的 body', async () => {
    const { state, response } = endless()
    ctx.runtime.use({ ...ctx.runtime, gateway: { handle: async () => response } })
    const socket = stalledClient()
    try {
      await until(() => state.pulled > 0, '开始读')
      // 等它撑满缓冲、停下来
      let last = -1
      await until(async () => {
        const seen = state.pulled
        await new Promise((resolve) => setTimeout(resolve, 200))
        const stopped = seen === last && seen === state.pulled
        last = seen
        return stopped
      }, '读到缓冲满就停', 20_000)
      expect(state.pulled).toBeLessThan(64 * MB)
      expect(state.cancelled).toBe(false)

      // 开始读，服务端才接着从上游读
      const stoppedAt = state.pulled
      socket.on('data', () => undefined)
      socket.resume()
      await until(() => state.pulled > stoppedAt, '读了之后接着读')
    } finally {
      socket.destroy()
    }
    await until(() => state.cancelled, '断开后取消 body')
  }, 30_000)

  it('响应还没出来时断开：交给网关的 Request 的 signal 也中止', async () => {
    let seen: AbortSignal | undefined
    ctx.runtime.use({
      ...ctx.runtime,
      gateway: {
        handle: (request: Request) => {
          seen = request.signal
          return new Promise<Response>(() => undefined)
        },
      },
    })
    const disconnect = new AbortController()
    const pending = realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/run/input`, { method: 'POST', signal: disconnect.signal }).catch(() => undefined)
    await until(() => seen, '请求到了网关')
    expect(seen!.aborted).toBe(false)
    disconnect.abort()
    await pending
    await until(() => seen!.aborted, 'signal 中止')
  })

  it('真的模型请求：runner 断开时上游被掐断', async () => {
    let upstreamAborted = false
    let reach!: () => void
    const reached = new Promise<void>((resolve) => (reach = resolve))
    const step: ScriptedStep = (_context, options) =>
      new Promise((resolve) => {
        reach()
        options.signal?.addEventListener('abort', () => {
          upstreamAborted = true
          resolve(fauxAssistantMessage('…'))
        })
      })
    const inline = createInlineDriver()
    const disconnecting: SandboxDriver = {
      name: 'disconnecting',
      reap: async () => {},
      async start(spec) {
        const redeemed = (await (await gateway('/sts/token', { body: { grantType: 'bootstrap', bootstrapToken: spec.credential.token, protocolVersion: RUNNER_PROTOCOL_VERSION } })).json()) as StsTokenResponse
        const disconnect = new AbortController()
        const stream = await realFetch(`${ctx.baseUrl}${AGENT_GATEWAY_PATH}/model/main/api/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${redeemed.token}` },
          body: JSON.stringify({ context: { messages: [] } }),
          signal: disconnect.signal,
        })
        expect(stream.status).toBe(200)
        await reached
        disconnect.abort()
        await until(() => upstreamAborted, '上游被掐断')
        return inline.start(spec)
      },
    }
    ctx.useScripted([step], { driver: disconnecting })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })
    await res.text()
    expect(upstreamAborted).toBe(true)
  }, 30_000)
})
}, { http: true })
