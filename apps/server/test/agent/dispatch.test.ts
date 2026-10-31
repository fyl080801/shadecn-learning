import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import { agentApiPath, AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { handleRunDispatch } from '@shadecn/mod-agent/dispatch'
import { replaceAgentRuntime } from '@shadecn/mod-agent/runtime'
import { attachCollabServer } from '@shadecn/mod-collab/hocuspocus'
import { flushCollabWrites } from '@shadecn/mod-collab/persistence'
import { bus, createBus, useBusForTesting, type Bus } from '@shadecn/server-kit/bus'
import { createMemoryBackend } from '@shadecn/server-kit/cluster/memory'
import { jsonCodec, stringCodec } from '@shadecn/server-kit/cluster'
import { useScripted } from '../helpers/agent.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * 发起一轮 = web 派发、agent 副本执行（docs/28 §3.6）。
 * 这里把 web 和 agent 拆成两个总线实例（同一个共享层），web 那个**没有**登记处理函数：
 * 请求只能派给 agent 那个，事件只能经派发日志回来。
 *
 * 注意：两个总线在同一个进程里，编排层（agentRuntime）也只有一份 —— 证明的是「派发和事件回传不靠进程内调用」，
 * 不是两个进程各有一份 runtime（那由 docs/28 §4 的 dev:cluster 验收覆盖）。
 */

const backend = createMemoryBackend()
const responders = backend.createMap('bus-responder', stringCodec)
const busOf = (instanceId: string): Bus =>
  createBus({ instanceId, channel: backend.createChannel('bus', jsonCodec()), responders })

let restore: (() => void) | undefined
let agentBus: Bus
let webBus: Bus

beforeAll(async () => {
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
  agentBus = busOf('agent-1')
  webBus = busOf('web-1')
  // agent 副本在它自己的总线上登记处理函数
  const previous = useBusForTesting(agentBus)
  await handleRunDispatch()
  previous()
  // 之后的请求都从 web 那个总线发出去
  restore = useBusForTesting(webBus)
})

afterEach(async () => {
  restore?.()
  await agentBus.close()
  await webBus.close()
  replaceAgentRuntime(null)
  await flushCollabWrites()
})

function parseSse(raw: string): AgentStreamEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
}

describe('发起一轮：派给另一个实例执行', () => {
  it('web 没有 agent → 派给 agent 实例；整条事件流经派发日志回到 web 的 SSE，首帧 RUN_STARTED、末帧 RUN_FINISHED', async () => {
    useScripted([fauxAssistantMessage([fauxText('你好，我在。')])])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '在吗' })

    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events[0]?.type).toBe(AgentEventType.RUN_STARTED)
    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    const text = events
      .filter((event) => event.type === AgentEventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as { delta: string }).delta)
      .join('')
    expect(text).toBe('你好，我在。')
  })

  it('一个 agent 实例都没有 → 503，说清楚是服务不可用', async () => {
    useScripted([])
    await agentBus.close()
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '在吗' })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { message: string }).message).toContain('没有正在运行的 agent 实例')
  })

  it('发起请求只交给一个实例（web 自己没登记，不会在 web 上跑）', async () => {
    expect(bus()).toBe(webBus)
    expect(await responders.entries('agent.start-run:')).toEqual([['agent.start-run:agent-1', 'agent-1']])
  })
})
