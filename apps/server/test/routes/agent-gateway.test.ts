import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { AGENT_GATEWAY_PATH, RUNNER_PROTOCOL_VERSION, type RunnerInput, type StsTokenResponse } from '@shadecn/agent/protocol'
import type { SandboxDriver } from '@shadecn/agent/sandbox/drivers'
import { createInlineDriver, SCRIPTED_API_KEY, SCRIPTED_UPSTREAM_URL } from '@shadecn/agent/testing'
import { agentApiPath, AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { replaceAgentRuntime } from '../../agent/index.ts'
import { app } from '../../app.ts'
import { attachCollabServer } from '../../collab/hocuspocus.ts'
import { flushCollabWrites } from '../../collab/persistence.ts'
import { useScripted } from '../helpers/agent.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * 网关的挂载（docs/22 §4）：`/api/agent-gateway/*` 在登录那道闸之外，只认 run 短令牌 ——
 * 浏览器的会话 cookie 在这里换不来任何东西；bootstrap token 兑换一次即废（被抢先兑换的那一轮起不来，以 RUN_ERROR 收尾）；
 * 换到的令牌只在这一轮活着的时候有效；交给 runner 的输入里没有真实的 key 和上游地址。
 */

beforeAll(async () => {
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  replaceAgentRuntime(null)
  await flushCollabWrites()
})

const GATEWAY_401 = { error: 'unauthorized', message: '令牌无效、已过期，或这一轮已经结束' }

function gateway(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  return app.request(`${AGENT_GATEWAY_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(init.body ?? {}),
  })
}

function parseSse(raw: string): AgentStreamEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
}

describe('网关的挂载', () => {
  it('在登录闸之外：没登录也到得了网关（回网关自己的 401，不是「需要登录」）；带着浏览器的会话 cookie 一样 401', async () => {
    useScripted([fauxAssistantMessage('x')])
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
    useScripted([fauxAssistantMessage('不该走到这里')], { driver: thief })
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
    expect(input!.skills.loaded).toEqual(['canvas', 'delegate'])
    expect(input!.model).not.toHaveProperty('baseUrl')
    expect(JSON.stringify(input)).not.toContain(SCRIPTED_API_KEY)
    expect(JSON.stringify(input)).not.toContain(SCRIPTED_UPSTREAM_URL)

    // 这一轮结束了：抢到的令牌就此作废
    const after = await gateway('/run/input', { headers: { authorization: `Bearer ${stolen!.token}` } })
    expect(after.status).toBe(401)
  })
})

describe('runner 协议版本不一致（镜像没重建）', () => {
  const MISMATCH_TEXT = (runner: string) =>
    `沙箱 runner 的协议版本 ${runner} 和服务端的 ${RUNNER_PROTOCOL_VERSION} 不一致，请重建沙箱镜像（pnpm build:sandbox-image）`

  /** 用一个报告指定版本的 runner 跑一轮；返回这一轮的 SSE 帧和服务端的 warn 日志 */
  async function runWith(driverOptions: { protocolVersion: number | null }) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useScripted([fauxAssistantMessage('不该走到这里')], { driver: createInlineDriver(driverOptions) })
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
    expect(warnings.some((line) => line.includes('[agent]') && line.includes('不一致') && line.includes('pnpm build:sandbox-image'))).toBe(true)
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
    useScripted([fauxAssistantMessage('好的')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const events = parseSse(await (await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
  })
})
