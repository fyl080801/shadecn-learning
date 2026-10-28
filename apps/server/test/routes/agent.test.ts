import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
  type FauxResponseStep,
} from '@mariozechner/pi-ai'
import { createAgentRuntime, type AgentRuntimeOptions } from '@shadecn/agent/session'
import type { AgentConversationStore, AgentRunLog } from '@shadecn/agent/store'
import {
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  agentApiPath,
  agentConversationPath,
  AgentEventType,
  agentRunEventsPath,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentSessionView,
  type AgentStreamEvent,
} from '@shadecn/shared/agent'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { replaceAgentRuntime } from '../../agent/index.ts'
import { attachCollabServer } from '../../collab/hocuspocus.ts'
import { flushCollabWrites, loadFlowState, roomOf } from '../../collab/persistence.ts'
import { AgentConversation, AgentRun, AgentToolCall } from '../../db/entities/index.ts'
import { agentConversations, agentRunLog } from '../../store/agent.ts'
import { users } from '../../store/users.ts'
import { db, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite, type Actor } from '../helpers/project.ts'

/**
 * 画布 Agent 的接口：鉴权口径、状态码、SSE 帧格式，「模型调工具 → 画布真的变了」那一整条，
 * 以及会话 / 运行日志真的落进测试库（store/agent.ts 的 MikroORM 实现）。
 * 模型是 pi-ai 的 faux provider（不碰网络 —— 测试里的 fetch 本来就会 reject）。
 */

let faux: FauxProviderRegistration | null = null

beforeAll(async () => {
  // agent 经 direct connection 写活房间，要有一个协同实例（不 listen）
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  replaceAgentRuntime(null)
  faux?.unregister()
  faux = null
  await flushCollabWrites()
})

function useFaux(responses: FauxResponseStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  faux = registerFauxProvider()
  faux.setResponses(responses)
  const runtime = createAgentRuntime({
    model: { model: faux.getModel(), apiKey: 'k', label: 'Faux' },
    store: agentConversations,
    runLog: agentRunLog,
    displayName: users.displayName,
    ...overrides,
  })
  replaceAgentRuntime(runtime)
  return runtime
}

/** 一条要等外面放行才回复的模型回复；被中止时立刻收尾 */
function gated() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const step: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(fauxAssistantMessage('完成')))
    })
  return { step, release }
}

/**
 * 两步的一轮：第一步说一段长话（faux 按 12–20 字切成多帧 TEXT_MESSAGE_CONTENT）再调工具，
 * 第二步卡在门口等测试放行。`reached` 在第二步开始时兑现 —— 那就是「运行中途」。
 */
function pausedMidRun() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const steps: FauxResponseStep[] = [
    fauxAssistantMessage([fauxText('先说一段比较长的话，'.repeat(6)), fauxToolCall('add_node', { type: 'text', label: '中途' })], {
      stopReason: 'toolUse',
    }),
    (_context, options) =>
      new Promise((resolve) => {
        reach()
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
        void gate.then(() => resolve(fauxAssistantMessage('放行之后又说了一段很长很长的话。'.repeat(6))))
      }),
  ]
  return { steps, release, reached }
}

/** 等这张画布上的那一轮彻底结束（落库、运行日志都写完） */
async function idle(runtime: { isRunning(flowId: string): boolean }, flowId: string) {
  for (let i = 0; i < 200 && runtime.isRunning(flowId); i += 1) await tick()
  expect(runtime.isRunning(flowId)).toBe(false)
}

function rejoin(who: Actor, flowId: string, runId: string) {
  return who.request(agentRunEventsPath(flowId, runId))
}

function send(who: Actor, flowId: string, body: unknown) {
  return who.json(`${agentApiPath(flowId)}/messages`, 'POST', body)
}

async function view(who: Actor, flowId: string): Promise<AgentSessionView> {
  return (await (await who.request(agentApiPath(flowId))).json()) as AgentSessionView
}

/** 跑完一轮，返回它的事件和会话 id（= RUN_STARTED 的 threadId） */
async function runTurn(who: Actor, flowId: string, text: string, conversationId: string | null = null) {
  const res = await send(who, flowId, { text, conversationId })
  expect(res.status).toBe(200)
  const events = parseSse(await res.text())
  const started = events[0]
  if (started?.type !== AgentEventType.RUN_STARTED) throw new Error('第一帧不是 RUN_STARTED')
  return { events, conversationId: started.threadId, runId: started.runId }
}

/** 按 AG-UI 的 HTTP 编码解析：每帧只有 `data:` 行 */
function parseSse(raw: string): AgentStreamEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
}

async function storedNodeLabels(flowId: string): Promise<string[]> {
  const state = await loadFlowState(roomOf(flowId))
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, state)
  return [...nodesMap(doc).values()].map((node) => (node.get('data') as Y.Map<unknown>).get('label') as string)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('未启用', () => {
  it('GET 回 enabled:false；发消息 503', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    expect(await view(alice, flowId)).toEqual({
      enabled: false,
      running: false,
      activeRun: null,
      latest: null,
    })
    expect((await send(alice, flowId, { text: '你好' })).status).toBe(503)
  })
})

describe('鉴权与参数', () => {
  it('非成员 → 404（GET 和发消息都是）', async () => {
    useFaux([fauxAssistantMessage('x')])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const flowId = await createFlow(alice, await createProject(alice))

    expect((await bob.request(agentApiPath(flowId))).status).toBe(404)
    expect((await send(bob, flowId, { text: '你好' })).status).toBe(404)
    expect((await bob.request(`${agentApiPath(flowId)}/abort`, { method: 'POST' })).status).toBe(404)
  })

  it('空 prompt / 超长 / 不是 JSON → 400', async () => {
    useFaux([fauxAssistantMessage('x')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    expect((await send(alice, flowId, { text: '   ' })).status).toBe(400)
    expect((await send(alice, flowId, { text: 'x'.repeat(5000) })).status).toBe(400)
    expect((await send(alice, flowId, { nope: 1 })).status).toBe(400)
    const raw = await alice.request(`${agentApiPath(flowId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(raw.status).toBe(400)
    // conversationId：不是字符串 / 空串 / 过长
    expect((await send(alice, flowId, { text: '你好', conversationId: 42 })).status).toBe(400)
    expect((await send(alice, flowId, { text: '你好', conversationId: '' })).status).toBe(400)
    expect((await send(alice, flowId, { text: '你好', conversationId: 'c'.repeat(500) })).status).toBe(400)
  })

  it('清空对话的 DELETE {agentApiPath} 已经没有了', async () => {
    useFaux([fauxAssistantMessage('x')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    expect((await alice.request(agentApiPath(flowId), { method: 'DELETE' })).status).toBe(404)
  })
})

describe('跑一轮', () => {
  it('模型调 add_node → 画布里出现节点 → SSE 收到工具事件和 RUN_FINISHED；帧里没有 event: 行', async () => {
    useFaux([
      fauxAssistantMessage([fauxText('好的'), fauxToolCall('add_node', { type: 'text', label: 'Agent 加的' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('加好了'),
    ])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await send(alice, flowId, { text: '加一个节点' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const raw = await res.text()
    expect(raw).not.toMatch(/^event:/m)

    const events = parseSse(raw)
    const types = events.map((event) => event.type)
    expect(types[0]).toBe(AgentEventType.RUN_STARTED)
    // threadId 是新建的会话 id，不再是画布 id
    const threadId = (events[0] as { threadId: string }).threadId
    expect(threadId).not.toBe(flowId)
    expect(events.at(-1)).toMatchObject({ threadId })
    expect(types[1]).toBe(AgentEventType.CUSTOM)
    expect(types).toContain(AgentEventType.TOOL_CALL_START)
    expect(types).toContain(AgentEventType.TOOL_CALL_RESULT)
    expect(types.at(-1)).toBe(AgentEventType.RUN_FINISHED)
    expect(events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)).toMatchObject({
      metadata: { status: 'done' },
    })

    await flushCollabWrites()
    expect(await storedNodeLabels(flowId)).toEqual(['Agent 加的'])

    // 会话落库了：归属这张画布 + 这个人
    const row = await db().findOneOrFail(AgentConversation, threadId)
    expect(row.flow.id).toBe(flowId)
    expect(row.user.id).toBe(alice.userId)

    // 对话记录：GET 读回来的就是这一轮
    const session = await view(alice, flowId)
    expect(session.running).toBe(false)
    expect(session.latest?.id).toBe(threadId)
    expect(session.latest?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(session.latest?.messages[1]).toMatchObject({ text: '好的\n\n加好了' })
  })

  it('个人画布也能跑', async () => {
    useFaux([
      fauxAssistantMessage([fauxToolCall('add_node', { type: 'process', label: '私人' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('好'),
    ])
    const alice = await actor()
    const space = (await (await alice.request('/api/projects/personal')).json()) as { id: string }
    const flowId = await createFlow(alice, space.id)

    const events = parseSse(await (await send(alice, flowId, { text: '加' })).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    await flushCollabWrites()
    expect(await storedNodeLabels(flowId)).toEqual(['私人'])
  })
})

describe('并发与控制', () => {
  it('同一张画布第二个发起者 → 409；只有发起人能中止；中止后流以 cancelled 收尾', async () => {
    const { step } = gated()
    useFaux([step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const first = await send(alice, flowId, { text: '慢慢来' })
    expect(first.status).toBe(200)
    await tick()

    const second = await send(bob, flowId, { text: '我也要' })
    expect(second.status).toBe(409)
    const running = (await (await bob.request(agentApiPath(flowId))).json()) as AgentSessionView
    expect(running.running).toBe(true)

    // 正在跑的会话删不掉 → 409；别人中止 → 403
    const [current] = (await (await alice.request(agentConversationPath(flowId))).json()) as AgentConversationSummary[]
    expect(current).toMatchObject({ running: true, messageCount: 1 })
    expect((await alice.request(agentConversationPath(flowId, current!.id), { method: 'DELETE' })).status).toBe(409)
    expect((await bob.request(`${agentApiPath(flowId)}/abort`, { method: 'POST' })).status).toBe(403)
    expect((await alice.request(`${agentApiPath(flowId)}/abort`, { method: 'POST' })).status).toBe(204)

    const events = parseSse(await first.text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })

    // 结束之后：中止幂等、删除成功
    expect((await alice.request(`${agentApiPath(flowId)}/abort`, { method: 'POST' })).status).toBe(204)
    expect((await alice.request(agentConversationPath(flowId, current!.id), { method: 'DELETE' })).status).toBe(204)
    expect((await view(alice, flowId)).latest).toBeNull()
  })

  it('不同画布互不排队', async () => {
    const a = gated()
    useFaux([a.step, fauxAssistantMessage('另一张')])
    const alice = await actor()
    const projectId = await createProject(alice)
    const one = await createFlow(alice, projectId, '一')
    const two = await createFlow(alice, projectId, '二')

    const first = await send(alice, one, { text: '慢' })
    await tick()
    const second = await send(alice, two, { text: '快' })
    expect(second.status).toBe(200)
    expect(parseSse(await second.text()).at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })

    a.release()
    expect(parseSse(await first.text()).at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
  })
})

describe('一轮不随连接中止，可以接回', () => {
  it('发起的连接断开后，这一轮照常跑完并落库', async () => {
    const { step, release } = gated()
    const runtime = useFaux([step])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await send(alice, flowId, { text: '我先走了' })
    expect(res.status).toBe(200)
    await tick()
    const { activeRun } = await view(alice, flowId)
    await res.body!.cancel()
    await tick()
    expect(runtime.isRunning(flowId)).toBe(true)

    release()
    await idle(runtime, flowId)
    const conversation = await db().findOneOrFail(AgentConversation, activeRun!.conversationId!, {
      populate: ['messages'],
    })
    const messages = JSON.parse(conversation.messages) as { role: string; text: string; error?: string }[]
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]).toMatchObject({ text: '完成' })
    expect(messages[1]).not.toHaveProperty('error')
    expect(await db().findOneOrFail(AgentRun, activeRun!.runId)).toMatchObject({ status: 'success', error: null })
  })

  it('运行中途接回：接回流与原始流逐帧相同（含 TEXT_MESSAGE_CONTENT），完整序列只来一次', async () => {
    const paused = pausedMidRun()
    useFaux(paused.steps)
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const origin = await send(alice, flowId, { text: '说长一点' })
    await paused.reached
    const { activeRun } = await view(alice, flowId)
    const rejoined = await rejoin(alice, flowId, activeRun!.runId)
    expect(rejoined.status).toBe(200)
    expect(rejoined.headers.get('content-type')).toContain('text/event-stream')

    paused.release()
    const [originRaw, rejoinedRaw] = await Promise.all([origin.text(), rejoined.text()])
    expect(rejoinedRaw).not.toMatch(/^event:/m)
    const originEvents = parseSse(originRaw)
    const rejoinedEvents = parseSse(rejoinedRaw)

    expect(rejoinedEvents).toEqual(originEvents)
    const types = rejoinedEvents.map((event) => event.type)
    expect(types.filter((type) => type === AgentEventType.TEXT_MESSAGE_CONTENT).length).toBeGreaterThan(4)
    expect(types.filter((type) => type === AgentEventType.RUN_STARTED)).toHaveLength(1)
    expect(types.filter((type) => type === AgentEventType.CUSTOM)).toHaveLength(1)
    expect(rejoinedEvents.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })

  it('别人接回 → 404；runId 不对 → 404；已经结束 → 404；非成员 → 404', async () => {
    const { step, release } = gated()
    const runtime = useFaux([step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const carol = await actor('carol')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const origin = await send(alice, flowId, { text: '慢慢来' })
    await tick()
    const { activeRun } = await view(alice, flowId)
    const runId = activeRun!.runId

    expect((await rejoin(bob, flowId, runId)).status).toBe(404)
    expect((await rejoin(carol, flowId, runId)).status).toBe(404)
    expect((await rejoin(alice, flowId, 'run_nope')).status).toBe(404)

    release()
    await origin.text()
    await idle(runtime, flowId)
    expect((await rejoin(alice, flowId, runId)).status).toBe(404)
  })

  it('补发缓冲溢出 → 接回 410；原始流照常收完', async () => {
    const paused = pausedMidRun()
    useFaux(paused.steps, { limits: { replayEvents: 3 } })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const origin = await send(alice, flowId, { text: '说长一点' })
    await paused.reached
    const { activeRun } = await view(alice, flowId)
    expect((await rejoin(alice, flowId, activeRun!.runId)).status).toBe(410)

    paused.release()
    const events = parseSse(await origin.text())
    expect(events[0]?.type).toBe(AgentEventType.RUN_STARTED)
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })

  it('中止后，接回的流以 RUN_FINISHED cancelled 收尾', async () => {
    const { step } = gated()
    useFaux([step])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const origin = await send(alice, flowId, { text: '慢慢来' })
    await tick()
    const { activeRun } = await view(alice, flowId)
    const rejoined = await rejoin(alice, flowId, activeRun!.runId)
    expect(rejoined.status).toBe(200)

    expect((await alice.request(`${agentApiPath(flowId)}/abort`, { method: 'POST' })).status).toBe(204)
    const events = parseSse(await rejoined.text())
    expect(events[0]?.type).toBe(AgentEventType.RUN_STARTED)
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
    expect(parseSse(await origin.text())).toEqual(events)
  })

  it('GET 给出 activeRun：发起人名字；会话 id 只给发起人；latest 是在跑的那个会话', async () => {
    const { step, release } = gated()
    const runtime = useFaux([fauxAssistantMessage('旧的'), step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const old = await runTurn(alice, flowId, '旧话题')
    const origin = await send(alice, flowId, { text: '新话题' })
    await tick()
    // 旧会话被拨成「最近更新」：latest 仍要选在跑的那个
    await db().nativeUpdate(AgentConversation, old.conversationId, { updatedAt: new Date(Date.now() + 60_000) })

    const mine = await view(alice, flowId)
    expect(mine.running).toBe(true)
    expect(mine.activeRun).toEqual({
      runId: expect.any(String),
      conversationId: expect.any(String),
      initiator: { id: alice.userId, name: 'alice' },
      mine: true,
      startedAt: expect.any(Number),
    })
    expect(mine.activeRun!.conversationId).not.toBe(old.conversationId)
    expect(mine.latest).toMatchObject({ id: mine.activeRun!.conversationId, running: true, messageCount: 1 })

    const theirs = await view(bob, flowId)
    expect(theirs.running).toBe(true)
    expect(theirs.activeRun).toEqual({ ...mine.activeRun, conversationId: null, mine: false })
    expect(theirs.latest).toBeNull()
    // 会话列表里的 running 只对发起人自己的会话成立
    expect((await (await bob.request(agentConversationPath(flowId))).json()) as unknown[]).toEqual([])

    release()
    await origin.text()
    await idle(runtime, flowId)
    const after = await view(alice, flowId)
    expect(after).toMatchObject({ running: false, activeRun: null })
    expect(after.latest?.id).toBe(old.conversationId)
  })
})

describe('会话', () => {
  it('新会话 → 续聊同一会话带上上下文 → 列表倒序、标题与摘要截断 → latest 是最近更新的那个', async () => {
    const seen: number[] = []
    const reply = (text: string): FauxResponseStep => (context) => {
      seen.push(context.messages.length)
      return fauxAssistantMessage(text)
    }
    useFaux([reply('第一轮回复'), reply(`**第二轮**${'很长'.repeat(100)}`), reply('另一个会话')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const longPrompt = `第一个问题\n${'问'.repeat(100)}`
    const first = await runTurn(alice, flowId, longPrompt)
    await tick()
    const second = await runTurn(alice, flowId, '接着说', first.conversationId)
    expect(second.conversationId).toBe(first.conversationId)
    await tick()
    const other = await runTurn(alice, flowId, '换个话题')
    expect(other.conversationId).not.toBe(first.conversationId)

    // 上下文：第一轮只有用户一；续聊带上了「用户一、助手一」；新会话从零开始
    expect(seen).toEqual([1, 3, 1])

    const list = (await (await alice.request(agentConversationPath(flowId))).json()) as AgentConversationSummary[]
    expect(list.map((row) => row.id)).toEqual([other.conversationId, first.conversationId])
    const [, mine] = list
    expect(mine).toMatchObject({ messageCount: 4, running: false })
    expect(Array.from(mine!.title)).toHaveLength(AGENT_TITLE_MAX_LENGTH)
    expect(mine!.title.startsWith('第一个问题 问问')).toBe(true)
    expect(Array.from(mine!.summary)).toHaveLength(AGENT_SUMMARY_MAX_LENGTH)
    expect(mine!.summary.startsWith('第二轮很长')).toBe(true)
    expect(typeof mine!.createdAt).toBe('number')
    expect(mine!.updatedAt).toBeGreaterThan(mine!.createdAt)
    expect(list[0]).not.toHaveProperty('messages')

    const full = (await (await alice.request(agentConversationPath(flowId, first.conversationId))).json()) as AgentConversationView
    expect(full.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(full.messages[0]).toMatchObject({ role: 'user', text: longPrompt })

    expect((await view(alice, flowId)).latest).toMatchObject({ id: other.conversationId, messageCount: 2 })

    // 续聊让旧会话重新排到最前
    useFaux([fauxAssistantMessage('又回来了')])
    await tick()
    await runTurn(alice, flowId, '再问一句', first.conversationId)
    expect((await view(alice, flowId)).latest?.id).toBe(first.conversationId)
  })

  it('别人的会话、不存在的会话一律 404：读、删、往里发消息都是', async () => {
    useFaux([fauxAssistantMessage('alice 的'), fauxAssistantMessage('不该走到这')])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const otherFlowId = await createFlow(alice, projectId, '另一张')

    const { conversationId } = await runTurn(alice, flowId, '我的会话')

    expect((await bob.request(agentConversationPath(flowId, conversationId))).status).toBe(404)
    expect((await bob.request(agentConversationPath(flowId, conversationId), { method: 'DELETE' })).status).toBe(404)
    expect((await send(bob, flowId, { text: '偷看', conversationId })).status).toBe(404)
    expect((await (await bob.request(agentConversationPath(flowId))).json()) as unknown[]).toEqual([])
    expect((await view(bob, flowId)).latest).toBeNull()
    // 同一个人、另一张画布：会话归属画布，也查不到
    expect((await alice.request(agentConversationPath(otherFlowId, conversationId))).status).toBe(404)
    expect((await send(alice, otherFlowId, { text: '串门', conversationId })).status).toBe(404)
    // 不存在的
    expect((await alice.request(agentConversationPath(flowId, 'conv_nope'))).status).toBe(404)
    expect((await alice.request(agentConversationPath(flowId, 'conv_nope'), { method: 'DELETE' })).status).toBe(404)
    expect((await send(alice, flowId, { text: '续', conversationId: 'conv_nope' })).status).toBe(404)

    // alice 的会话原封不动
    const kept = (await (await alice.request(agentConversationPath(flowId, conversationId))).json()) as AgentConversationView
    expect(kept.messageCount).toBe(2)
  })

  it('删除会话 → 204，之后列表里没有它', async () => {
    useFaux([fauxAssistantMessage('一'), fauxAssistantMessage('二')])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const a = await runTurn(alice, flowId, '甲')
    const b = await runTurn(alice, flowId, '乙')

    expect((await alice.request(agentConversationPath(flowId, a.conversationId), { method: 'DELETE' })).status).toBe(204)
    const list = (await (await alice.request(agentConversationPath(flowId))).json()) as AgentConversationSummary[]
    expect(list.map((row) => row.id)).toEqual([b.conversationId])
  })
})

describe('运行日志', () => {
  it('每轮一行、每次工具调用一行；参数只有摘要，不含正文', async () => {
    useFaux([
      fauxAssistantMessage(
        [
          fauxToolCall('add_node', { type: 'text', label: '机密标题', text: '机密正文' }),
          fauxToolCall('delete_elements', { ids: ['n_missing'] }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('好了'),
    ])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const { runId, conversationId } = await runTurn(alice, flowId, '加一个机密节点')

    const run = await db().findOneOrFail(AgentRun, runId)
    expect(run).toMatchObject({
      conversationId,
      flowId,
      userId: alice.userId,
      status: 'success',
      error: null,
      toolCallCount: 2,
      model: 'Faux',
    })
    expect(run.finishedAt).toBeInstanceOf(Date)

    const calls = await db().find(AgentToolCall, { runId }, { orderBy: { createdAt: 'asc' } })
    expect(calls.map((call) => [call.name, call.ok])).toEqual([
      ['add_node', true],
      ['delete_elements', false],
    ])
    expect(calls[0]!.args).toBe('type=text label(4字) text(4字)')
    expect(JSON.parse(calls[0]!.elementIds)).toHaveLength(1)
    expect(calls[1]!.args).toBe('ids=[n_missing]')
    expect(calls[1]!.error).toContain('n_missing')
    expect(JSON.stringify(calls)).not.toMatch(/机密/)
  })

  it('运行日志写失败不影响这一轮：照样 RUN_FINISHED，对话照样落库', async () => {
    const broken: AgentRunLog = {
      startRun: async () => {
        throw new Error('日志表挂了')
      },
      recordToolCall: async () => {
        throw new Error('日志表挂了')
      },
      finishRun: async () => {
        throw new Error('日志表挂了')
      },
    }
    useFaux(
      [
        fauxAssistantMessage([fauxToolCall('add_node', { type: 'process', label: '照样加' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('好'),
      ],
      { runLog: broken },
    )
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const { events, conversationId } = await runTurn(alice, flowId, '加')

    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect((await view(alice, flowId)).latest).toMatchObject({ id: conversationId, messageCount: 2 })
    await flushCollabWrites()
    expect(await storedNodeLabels(flowId)).toEqual(['照样加'])
  })

  it('对话没能保存 → 以 RUN_ERROR（persist_failed）收尾；画布改动保留，运行日志记为 error', async () => {
    const failingSave: AgentConversationStore = {
      ...agentConversations,
      save: async () => {
        throw new Error('磁盘满了')
      },
    }
    useFaux(
      [
        fauxAssistantMessage([fauxToolCall('add_node', { type: 'process', label: '已经加上' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('好'),
      ],
      { store: failingSave },
    )
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const { events, runId } = await runTurn(alice, flowId, '加')

    const last = events.at(-1)
    expect(last).toMatchObject({ type: AgentEventType.RUN_ERROR, code: 'persist_failed' })
    expect(last?.type === AgentEventType.RUN_ERROR ? last.message : '').toContain('刷新后会丢失')
    expect(events.map((event) => event.type)).not.toContain(AgentEventType.RUN_FINISHED)
    await flushCollabWrites()
    expect(await storedNodeLabels(flowId)).toEqual(['已经加上'])
    expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ status: 'error' })
  })
})
