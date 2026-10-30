import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { RunAuthorityError } from '../src/authority.ts'
import { createAgentGateway, type GatewayRunHandlers } from '../src/gateway.ts'
import {
  AGENT_GATEWAY_PATH,
  PROTOCOL_MISMATCH_ERROR,
  RUNNER_PROTOCOL_VERSION,
  type ProtocolMismatchBody,
  type RunnerEvent,
  type StsTokenResponse,
} from '../src/protocol.ts'
import { runTokenClaims, signRunToken } from '../src/token.ts'

/**
 * 网关本身（不经 runner）：STS（bootstrap 一次性、续期、令牌声明）、401 的几种来路、请求体校验与事件批次顺序、
 * 模型代理（注入真实 key、只放行这个模型的那一个接口、流式透传、判 llm:invoke、叫停即掐断上游）。
 * runner 经它跑完整一轮的样子在 session / canvas-changes / authority 的用例里。
 */

const SECRET = 'gateway-test-secret'
const BASE = `http://gw.test${AGENT_GATEWAY_PATH}`
const UPSTREAM_KEY = 'sk-real-upstream-key'

const model = {
  id: 'm-1',
  name: 'M1',
  api: 'openai-completions',
  provider: 'p',
  baseUrl: 'http://upstream.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<Api>

interface Upstream {
  fetch: typeof fetch
  calls: { url: string; headers: Headers; body: string; signal: AbortSignal | undefined }[]
  /** 下一次回复：默认一段两帧的 SSE */
  reply?: (signal: AbortSignal | undefined) => Response
}

function upstream(): Upstream {
  const state: Upstream = {
    calls: [],
    fetch: async (input, init) => {
      const signal = init?.signal ?? undefined
      state.calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body), signal })
      if (state.reply) return state.reply(signal)
      return new Response('data: {"a":1}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'set-cookie': 'x=1' },
      })
    },
  }
  return state
}

function handlers(overrides: Partial<GatewayRunHandlers> = {}): GatewayRunHandlers & { batches: RunnerEvent[][]; llmChecks: number; mismatches: { runnerVersion: number | null; serverVersion: number }[] } {
  const out = {
    batches: [] as RunnerEvent[][],
    llmChecks: 0,
    mismatches: [] as { runnerVersion: number | null; serverVersion: number }[],
    input: async () => ({ runId: 'run_1' }) as never,
    tool: async () => ({ isError: true as const, message: 'x' }),
    changes: async () => ({ change: null }),
    delegate: async () => ({ ok: false as const, message: '不派' }),
    agentFinish: async () => ({ isError: true, text: 'x', summary: 'x', changedNodeIds: [] }),
    events(events: RunnerEvent[]) {
      out.batches.push(events)
    },
    finish() {},
    protocolMismatch(info: { runnerVersion: number | null; serverVersion: number }) {
      out.mismatches.push(info)
    },
    async authorizeLlm() {
      out.llmChecks += 1
    },
    async authorizeRenewal() {},
    ...overrides,
  }
  return out
}

function setup(options: { now?: () => number; buildId?: string; handlers?: Partial<GatewayRunHandlers> } = {}) {
  const up = upstream()
  const gateway = createAgentGateway({ secret: SECRET, upstream: { model, apiKey: UPSTREAM_KEY }, fetch: up.fetch, ...(options.now ? { now: options.now } : {}), ...(options.buildId ? { buildId: options.buildId } : {}) })
  const abort = new AbortController()
  const h = handlers(options.handlers)
  const run = gateway.open({ runId: 'run_1', userId: 'u1', grantId: 'g1', scope: 'flow:f:read', signal: abort.signal, handlers: h })
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    gateway.handle(
      new Request(`${BASE}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )
  const redeem = async () => {
    const res = await post('/sts/token', { grantType: 'bootstrap', bootstrapToken: run.bootstrapToken, protocolVersion: RUNNER_PROTOCOL_VERSION })
    expect(res.status).toBe(200)
    return (await res.json()) as StsTokenResponse
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  return { gateway, run, abort, handlers: h, upstream: up, post, redeem, bearer }
}

const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>

describe('协议版本（硬校验）与构建 id（软提示）', () => {
  afterEach(() => vi.restoreAllMocks())

  const redeemBody = (t: ReturnType<typeof setup>, extra: Record<string, unknown>) => ({
    grantType: 'bootstrap',
    bootstrapToken: t.run.bootstrapToken,
    ...extra,
  })

  it('版本一致 → 200，不惊动编排层', async () => {
    const t = setup()
    const res = await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION }))
    expect(res.status).toBe(200)
    expect(t.handlers.mismatches).toEqual([])
  })

  it('版本不一致 → 409 protocol_mismatch（含双方版本号），通知编排层，且这个 bootstrap 被作废', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup()
    const res = await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION + 1 }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as ProtocolMismatchBody
    expect(body).toMatchObject({ error: PROTOCOL_MISMATCH_ERROR, runnerVersion: RUNNER_PROTOCOL_VERSION + 1, serverVersion: RUNNER_PROTOCOL_VERSION })
    expect(body.message).toContain('重建沙箱镜像')
    expect(t.handlers.mismatches).toEqual([{ runnerVersion: RUNNER_PROTOCOL_VERSION + 1, serverVersion: RUNNER_PROTOCOL_VERSION }])
    // 被拒的兑换同样作废 bootstrap：带上正确的版本再来也是 401
    const retry = await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION }))
    expect(retry.status).toBe(401)
  })

  it('缺少版本字段（老镜像）或类型不对 → 同样 409，runnerVersion 为 null，bootstrap 作废', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const extra of [{}, { protocolVersion: '1' }, { protocolVersion: 1.5 }]) {
      const t = setup()
      const res = await t.post('/sts/token', redeemBody(t, extra))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: PROTOCOL_MISMATCH_ERROR, runnerVersion: null, serverVersion: RUNNER_PROTOCOL_VERSION })
      expect(t.handlers.mismatches).toEqual([{ runnerVersion: null, serverVersion: RUNNER_PROTOCOL_VERSION }])
      expect((await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION }))).status).toBe(401)
    }
  })

  it('bootstrap 本身无效 → 仍是 401（拿不到有效 bootstrap 的人看不到版本号）', async () => {
    const t = setup()
    const res = await t.post('/sts/token', { grantType: 'bootstrap', bootstrapToken: 'made-up', protocolVersion: RUNNER_PROTOCOL_VERSION + 1 })
    expect(res.status).toBe(401)
    expect(t.handlers.mismatches).toEqual([])
  })

  it('双方都是构建产物且不是同一次构建 → 只打一条 warn，照常放行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ buildId: 'build-server' })
    const res = await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION, buildId: 'build-runner' }))
    expect(res.status).toBe(200)
    const lines = warn.mock.calls.map((call) => String(call[0]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('沙箱镜像和服务端不是同一次构建')
    expect(lines[0]).toContain('build-runner')
    expect(lines[0]).toContain('build-server')
  })

  it('同一次构建、或任何一方是 source（源码运行）/ 没报 → 不打 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: [string, Record<string, unknown>][] = [
      ['build-1', { buildId: 'build-1' }],
      ['source', { buildId: 'build-2' }],
      ['build-1', { buildId: 'source' }],
      ['build-1', {}],
    ]
    for (const [serverBuild, extra] of cases) {
      const t = setup({ buildId: serverBuild })
      expect((await t.post('/sts/token', redeemBody(t, { protocolVersion: RUNNER_PROTOCOL_VERSION, ...extra }))).status).toBe(200)
    }
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('STS', () => {
  it('bootstrap token 兑换一次即失效；换到的令牌带着这一轮的声明，10 分钟', async () => {
    const at = Date.UTC(2026, 9, 29)
    const t = setup({ now: () => at })
    const { token, expiresAt } = await t.redeem()
    expect(decode(token)).toMatchObject({ sub: 'user:u1', act: { sub: 'agent-run:run_1' }, grant_id: 'g1', aud: 'agent-gateway', scope: 'flow:f:read' })
    expect(expiresAt).toBe(at + 10 * 60_000)
    const again = await t.post('/sts/token', { grantType: 'bootstrap', bootstrapToken: t.run.bootstrapToken })
    expect(again.status).toBe(401)
  })

  it('bootstrap token 过了有效期、这一轮已关、或根本不是它 → 401', async () => {
    let now = 0
    const t = setup({ now: () => now })
    now = 61_000
    expect((await t.post('/sts/token', { grantType: 'bootstrap', bootstrapToken: t.run.bootstrapToken })).status).toBe(401)

    const closed = setup()
    closed.run.close()
    expect((await closed.post('/sts/token', { grantType: 'bootstrap', bootstrapToken: closed.run.bootstrapToken })).status).toBe(401)
    expect((await closed.post('/sts/token', { grantType: 'bootstrap', bootstrapToken: 'made-up' })).status).toBe(401)
  })

  it('续期：拿有效令牌换一张新的（jti 不同）；Grant 失效 / 令牌过期 → 401', async () => {
    let now = Date.UTC(2026, 9, 29)
    let alive = true
    const t = setup({
      now: () => now,
      handlers: {
        async authorizeRenewal() {
          if (!alive) throw new RunAuthorityError('revoked', '失权了')
        },
      },
    })
    const first = await t.redeem()
    const renewed = await t.post('/sts/token', { grantType: 'renew' }, t.bearer(first.token))
    expect(renewed.status).toBe(200)
    const second = (await renewed.json()) as StsTokenResponse
    expect(decode(second.token).jti).not.toBe(decode(first.token).jti)

    alive = false
    expect((await t.post('/sts/token', { grantType: 'renew' }, t.bearer(second.token))).status).toBe(401)
    alive = true
    now += 11 * 60_000
    expect((await t.post('/sts/token', { grantType: 'renew' }, t.bearer(second.token))).status).toBe(401)
  })
})

describe('令牌失效一律 401', () => {
  it('没有令牌 / 伪造签名 / 过期 / 别的 run / Grant 对不上 / 这一轮已关 / 只带会话 cookie', async () => {
    const at = Date.UTC(2026, 9, 29)
    const t = setup({ now: () => at })
    const { token } = await t.redeem()
    expect((await t.post('/run/input', {}, t.bearer(token))).status).toBe(200)

    const mint = (overrides: Partial<Parameters<typeof runTokenClaims>[0]>, secret = SECRET) =>
      signRunToken(runTokenClaims({ runId: 'run_1', userId: 'u1', grantId: 'g1', scope: '', now: at, ttlMs: 60_000, ...overrides }), secret)

    const cases: [string, Record<string, string>][] = [
      ['没有令牌', {}],
      ['会话 cookie', { cookie: 'sid=whatever' }],
      ['伪造签名', t.bearer(mint({}, 'attacker-secret'))],
      ['过期', t.bearer(mint({ now: at - 120_000 }))],
      ['别的 run', t.bearer(mint({ runId: 'run_other' }))],
      ['Grant 对不上', t.bearer(mint({ grantId: 'g-other' }))],
      ['别的发起人', t.bearer(mint({ userId: 'u2' }))],
    ]
    for (const [label, headers] of cases) {
      const res = await t.post('/run/input', {}, headers)
      expect([label, res.status]).toEqual([label, 401])
    }

    t.run.close()
    expect((await t.post('/run/input', {}, t.bearer(token))).status).toBe(401)
    expect((await t.post('/events', { seq: 0, events: [] }, t.bearer(token))).status).toBe(401)
  })
})

describe('请求体', () => {
  it('事件批次只收下一批：重放 / 跳号 409；形状不对 400；之后照常', async () => {
    const t = setup()
    const { token } = await t.redeem()
    const batch = (seq: number) => ({ seq, events: [{ type: 'turn_end', toolResultCount: 0 }] })
    expect((await t.post('/events', batch(0), t.bearer(token))).status).toBe(200)
    expect((await t.post('/events', batch(0), t.bearer(token))).status).toBe(409)
    expect((await t.post('/events', batch(2), t.bearer(token))).status).toBe(409)
    expect((await t.post('/events', { seq: 1, events: [{ type: 'made_up' }] }, t.bearer(token))).status).toBe(400)
    expect((await t.post('/events', { seq: 1, events: [{ type: 'message_end', message: { role: 'system', content: 'x' } }] }, t.bearer(token))).status).toBe(400)
    expect((await t.post('/events', '{oops', t.bearer(token))).status).toBe(400)
    expect((await t.post('/events', batch(1), t.bearer(token))).status).toBe(200)
    expect(t.handlers.batches).toHaveLength(2)
  })

  it('只接受 POST；没有的路径 404', async () => {
    const t = setup()
    const { token } = await t.redeem()
    expect((await t.gateway.handle(new Request(`${BASE}/run/input`, { headers: t.bearer(token) }))).status).toBe(405)
    expect((await t.post('/nope', {}, t.bearer(token))).status).toBe(404)
  })
})

describe('模型代理', () => {
  const chat = (body: unknown = { model: 'm-1', messages: [] }) => JSON.stringify(body)

  it('注入真实 key、换掉 runner 的令牌；去掉压缩 / cookie 头；流式透传；每次判 llm:invoke', async () => {
    const t = setup()
    const { token } = await t.redeem()
    const res = await t.post('/llm/chat/completions', chat(), { ...t.bearer(token), cookie: 'sid=x', 'accept-encoding': 'gzip' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()

    const [call] = t.upstream.calls
    expect(call!.url).toBe('http://upstream.test/v1/chat/completions')
    expect(call!.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(call!.headers.get('cookie')).toBeNull()
    expect(JSON.stringify([...call!.headers])).not.toContain(token)
    expect(t.handlers.llmChecks).toBe(1)
  })

  it('别的接口 404、别的模型 403、令牌不对 401（都不打上游）', async () => {
    const t = setup()
    const { token } = await t.redeem()
    expect((await t.post('/llm/files', chat(), t.bearer(token))).status).toBe(404)
    expect((await t.post('/llm/chat/completions', chat({ model: 'gpt-expensive' }), t.bearer(token))).status).toBe(403)
    expect((await t.post('/llm/chat/completions', chat(), t.bearer('forged.token.here'))).status).toBe(401)
    expect(t.upstream.calls).toHaveLength(0)
  })

  it('判 llm:invoke：denied → 403（原因给 SDK），失效 → 401；都不打上游', async () => {
    let kind: 'denied' | 'revoked' = 'denied'
    const t = setup({
      handlers: {
        async authorizeLlm() {
          throw new RunAuthorityError(kind, kind === 'denied' ? '这一轮没有被授予 llm:invoke' : '失权了')
        },
      },
    })
    const { token } = await t.redeem()
    const denied = await t.post('/llm/chat/completions', chat(), t.bearer(token))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { message: '这一轮没有被授予 llm:invoke', type: 'agent_gateway_error' } })
    kind = 'revoked'
    expect((await t.post('/llm/chat/completions', chat(), t.bearer(token))).status).toBe(401)
    expect(t.upstream.calls).toHaveLength(0)
  })

  it('这一轮被叫停：在途的上游请求随之掐断，流以协议内的错误帧正常结束（不是 HTTP 层的流错误）；之后的请求 401', async () => {
    const t = setup()
    t.upstream.reply = (signal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
        { status: 200 },
      )
    const { token } = await t.redeem()
    const res = await t.post('/llm/chat/completions', chat(), t.bearer(token))
    const reader = res.body!.getReader()
    await reader.read()
    t.abort.abort()
    t.run.close()
    expect(t.upstream.calls[0]!.signal?.aborted).toBe(true)
    const tail = await reader.read()
    expect(new TextDecoder().decode(tail.value)).toBe(
      'data: {"error":{"message":"这一轮已经停止，模型请求已取消","type":"agent_gateway_error"}}\n\n',
    )
    expect((await reader.read()).done).toBe(true)
    expect((await t.post('/llm/chat/completions', chat(), t.bearer(token))).status).toBe(401)
  })

  it('Anthropic 协议：key 注入到 x-api-key，runner 的令牌也可以从 x-api-key 来', async () => {
    const up = upstream()
    const gateway = createAgentGateway({
      secret: SECRET,
      upstream: { model: { ...model, api: 'anthropic-messages', baseUrl: 'https://anthropic.test' }, apiKey: UPSTREAM_KEY },
      fetch: up.fetch,
    })
    const run = gateway.open({ runId: 'run_a', userId: 'u1', grantId: 'g1', scope: '', signal: new AbortController().signal, handlers: handlers() })
    const redeemed = await gateway.handle(
      new Request(`${BASE}/sts/token`, { method: 'POST', body: JSON.stringify({ grantType: 'bootstrap', bootstrapToken: run.bootstrapToken, protocolVersion: RUNNER_PROTOCOL_VERSION }) }),
    )
    const { token } = (await redeemed.json()) as StsTokenResponse
    const res = await gateway.handle(
      new Request(`${BASE}/llm/v1/messages?beta=true`, { method: 'POST', headers: { 'x-api-key': token }, body: chat() }),
    )
    expect(res.status).toBe(200)
    expect(up.calls[0]!.url).toBe('https://anthropic.test/v1/messages?beta=true')
    expect(up.calls[0]!.headers.get('x-api-key')).toBe(UPSTREAM_KEY)
    expect(up.calls[0]!.headers.get('authorization')).toBeNull()
  })
})
