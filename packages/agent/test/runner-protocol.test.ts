import { describe, expect, it } from 'vitest'
import { BUILD_ID, buildsDiffer, SOURCE_BUILD_ID } from '../src/build-id.ts'
import {
  GATEWAY_ROUTES,
  isModelStreamRequest,
  parseEventsRequest,
  parseStsTokenRequest,
  parseAgentTaskFinishRequest,
  PROTOCOL_MISMATCH_ERROR,
  RUNNER_PROTOCOL_VERSION,
  runnerEventOf,
} from '../src/protocol.ts'
import { createGatewayClient, GatewayUnauthorizedError, RunnerProtocolMismatchError } from '../src/runner/client.ts'

/**
 * runner 一侧的版本握手：兑换请求里带 protocolVersion / buildId；网关回 409 protocol_mismatch 变成独立的错误类型
 * （main.ts 据此以退出码 4 退出），401 仍是另一类。网关一侧的判定在 gateway.test.ts。
 */

function clientWith(reply: (body: Record<string, unknown>) => Response, options: { protocolVersion?: number | null; buildId?: string } = {}) {
  const bodies: Record<string, unknown>[] = []
  const client = createGatewayClient({
    baseUrl: 'http://gw.test/api/agent-gateway',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return reply(body)
    },
    ...options,
  })
  return { client, bodies }
}

const ok = () => new Response(JSON.stringify({ token: 't', expiresAt: Date.now() + 600_000 }), { status: 200 })
const mismatch = (runnerVersion: number | null) =>
  new Response(
    JSON.stringify({ error: PROTOCOL_MISMATCH_ERROR, message: '版本不一致', runnerVersion, serverVersion: RUNNER_PROTOCOL_VERSION + 1 }),
    { status: 409 },
  )

describe('runner 的版本握手', () => {
  it('兑换请求带着协议版本和构建 id（源码运行是 source）', async () => {
    const { client, bodies } = clientWith(ok)
    await client.redeem('boot')
    expect(bodies[0]).toEqual({ grantType: 'bootstrap', bootstrapToken: 'boot', protocolVersion: RUNNER_PROTOCOL_VERSION, buildId: BUILD_ID })
    expect(BUILD_ID).toBe(SOURCE_BUILD_ID)
  })

  it('protocolVersion: null（测试模拟老镜像）→ 请求里没有这个字段', async () => {
    const { client, bodies } = clientWith(ok, { protocolVersion: null, buildId: 'b1' })
    await client.redeem('boot')
    expect(bodies[0]).toEqual({ grantType: 'bootstrap', bootstrapToken: 'boot', buildId: 'b1' })
  })

  it('网关回 409 protocol_mismatch → RunnerProtocolMismatchError（带双方版本），不是 401 那类', async () => {
    const { client } = clientWith(() => mismatch(7))
    const err = await client.redeem('boot').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunnerProtocolMismatchError)
    expect(err).not.toBeInstanceOf(GatewayUnauthorizedError)
    expect(err).toMatchObject({ runnerVersion: 7, serverVersion: RUNNER_PROTOCOL_VERSION + 1 })
  })

  it('401 仍是 GatewayUnauthorizedError；别的 409 是普通错误', async () => {
    const unauthorized = clientWith(() => new Response(JSON.stringify({ error: 'unauthorized', message: 'x' }), { status: 401 }))
    expect(await unauthorized.client.redeem('b').catch((e: unknown) => e)).toBeInstanceOf(GatewayUnauthorizedError)
    const other = clientWith(() => new Response(JSON.stringify({ error: 'conflict', message: 'x' }), { status: 409 }))
    const err = await other.client.redeem('b').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(RunnerProtocolMismatchError)
  })
})

describe('请求体解析与构建 id 比较', () => {
  it('parseStsTokenRequest：缺失或类型不对的版本 / 构建 id 解析为 null', () => {
    expect(parseStsTokenRequest({ grantType: 'bootstrap', bootstrapToken: 'b', protocolVersion: 3, buildId: 'x' })).toEqual({
      grantType: 'bootstrap',
      bootstrapToken: 'b',
      protocolVersion: 3,
      buildId: 'x',
    })
    expect(parseStsTokenRequest({ grantType: 'bootstrap', bootstrapToken: 'b' })).toMatchObject({ protocolVersion: null, buildId: null })
    expect(parseStsTokenRequest({ grantType: 'bootstrap', bootstrapToken: 'b', protocolVersion: '3', buildId: 5 })).toMatchObject({
      protocolVersion: null,
      buildId: null,
    })
  })

  it('第 7 版的线格式：事件只认工具的开始 / 结束（老的 message_update / message_end / turn_end 夹在里面整批拒）', () => {
    const start = { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_canvas', args: {} }
    const end = { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read_canvas', result: { content: [] }, isError: false, agentId: 'sub_1' }
    expect(parseEventsRequest({ seq: 0, events: [start, end] })).toEqual({ seq: 0, events: [start, { ...end, result: { content: [], details: undefined } }] })
    for (const stale of [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'user', content: '通知' }, steerId: 'chg_1' },
      { type: 'turn_end', toolResultCount: 0 },
    ]) {
      expect(parseEventsRequest({ seq: 0, events: [start, stale] })).toBeNull()
    }
    // runner 这边同样不报它们
    expect(runnerEventOf({ type: 'turn_end', message: {}, toolResults: [] } as never)).toBeNull()
    expect(runnerEventOf({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'x' } } as never)).toBeNull()
  })

  it('第 7 版的线格式：/agent/finish 只取 agentId；模型请求体只要是个 JSON 对象（内容不看）；没有取通知的路由', () => {
    expect(parseAgentTaskFinishRequest({ agentId: 'sub_1', status: 'needs_confirmation', text: '编的', question: '编的', error: null })).toEqual({ agentId: 'sub_1' })
    expect(parseAgentTaskFinishRequest({ status: 'done' })).toBeNull()
    expect(isModelStreamRequest({ model: {}, context: { messages: [] }, options: {} })).toBe(true)
    expect(isModelStreamRequest({ context: { messages: 'not checked' } })).toBe(true)
    expect(isModelStreamRequest([])).toBe(false)
    expect(isModelStreamRequest('x')).toBe(false)
    expect(Object.values(GATEWAY_ROUTES)).not.toContain('/canvas/changes')
  })

  it('buildsDiffer：只有双方都是构建产物且不同才算', () => {
    expect(buildsDiffer('a', 'b')).toBe(true)
    expect(buildsDiffer('a', 'a')).toBe(false)
    expect(buildsDiffer('a', 'source')).toBe(false)
    expect(buildsDiffer('source', 'b')).toBe(false)
    expect(buildsDiffer('a', null)).toBe(false)
  })
})
