import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'
import type { AgentRuntimeOptions } from '@shadecn/agent/session'
import type { ScriptedStep } from '@shadecn/agent/testing'
import { agentApiPath, AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import {
  ACCESS_REVOKED,
  agentAuthority,
  createGrantAuthority,
  GRANT_EXPIRED,
  revokeAllGrantsForUser,
  startAgentReconciler,
  type GrantAuthority,
} from '../../agent/authority.ts'
import { replaceAgentRuntime } from '../../agent/index.ts'
import { useScripted } from '../helpers/agent.ts'
import { attachCollabServer } from '../../collab/hocuspocus.ts'
import { flushCollabWrites } from '../../collab/persistence.ts'
import { notifyAccessRevoked } from '../../collab/revocation.ts'
import { AgentGrant, AgentGrantScope, AgentRun, AgentToolCall, ProjectMember, Session } from '../../db/entities/index.ts'
import { agentGrants } from '../../store/agent.ts'
import { db, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite, type Actor } from '../helpers/project.ts'

/**
 * 一轮 agent 的执行身份（docs/22 第一期）：真的走路由发起、真的签 Grant 落进测试库、真的经 direct connection 写活房间。
 * 守的是：开始时签发 Grant（scope 落库、运行日志与工具调用日志带 grantId）；失权（移出项目 / 删画布）当场叫停
 * 这一轮、以 cancelled 收尾并写明原因，同一个人在别的画布上的照常跑；退出登录 / 会话没了不影响；
 * Grant 到期 → expired；定时对账（悄悄失权、孤儿 Grant）；账号级撤销。
 */

beforeAll(async () => {
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  replaceAgentRuntime(null)
  vi.restoreAllMocks()
  await flushCollabWrites()
})

function useFaux(responses: ScriptedStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  return useScripted(responses, overrides)
}

/** 一条要等外面放行才回复的模型回复；被中止时立刻收尾。`reached` 在模型被请求时兑现 */
function gated(reply = '完成') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  let calls = 0
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      calls += 1
      reach()
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(fauxAssistantMessage(reply)))
    })
  return { step, release, reached, calls: () => calls }
}

function send(who: Actor, flowId: string, text: string) {
  return who.json(`${agentApiPath(flowId)}/messages`, 'POST', { text })
}

function parseSse(raw: string): AgentStreamEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
}

/** 等这一轮被签好 Grant（进了对账表） */
async function liveOn(flowId: string, authority: GrantAuthority = agentAuthority) {
  for (let i = 0; i < 200; i += 1) {
    const entry = authority.live().find((grant) => grant.flowId === flowId)
    if (entry) return entry
    await tick()
  }
  throw new Error('这张画布上没有在跑的 Grant')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

function runIdOf(events: AgentStreamEvent[]): string {
  const started = events[0]
  if (started?.type !== AgentEventType.RUN_STARTED) throw new Error('第一帧不是 RUN_STARTED')
  return started.runId
}

describe('签发与审计', () => {
  it('开始时签发 Grant：scope 按发起人此刻的权限落库；运行日志、工具调用日志都带 grantId；结束时 Grant 关掉', async () => {
    useFaux([
      fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '一' } })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('好了'),
    ])
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const events = parseSse(await (await send(alice, flowId, '加一个')).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    const runId = runIdOf(events)

    const grant = await db().findOneOrFail(AgentGrant, { runId })
    expect(grant).toMatchObject({
      userId: alice.userId,
      flowId,
      projectId,
      projectKind: 'team',
      personalOwnerId: null,
      revokeReason: '本轮已结束（完成）',
    })
    expect(grant.revokedAt).not.toBeNull()
    // 绝对过期时间 = 签发时刻 + 一轮的时长上限（5 分钟）+ 余量
    expect(grant.expiresAt.getTime() - grant.createdAt.getTime()).toBeGreaterThanOrEqual(5 * 60_000)

    const scopes = await db().find(AgentGrantScope, { grantId: grant.id }, { orderBy: { scope: 'asc' } })
    // 没配沙箱：没有 sandbox:exec
    expect(scopes.map((row) => [row.scope, row.resource, row.onRevoke, row.required])).toEqual([
      ['flow:delete', `flow:${flowId}`, 'stop', true],
      ['flow:read', `flow:${flowId}`, 'stop', true],
      ['flow:write', `flow:${flowId}`, 'stop', true],
      ['llm:invoke', 'model:Faux', 'stop', true],
    ])

    expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ grantId: grant.id, status: 'success' })
    const calls = await db().find(AgentToolCall, { runId })
    expect(calls.map((call) => [call.name, call.grantId])).toEqual([['add_node', grant.id]])
    expect(agentAuthority.live()).toEqual([])
  })

  it('个人画布：快照里记下所有者', async () => {
    useFaux([fauxAssistantMessage('好')])
    const alice = await actor()
    const space = (await (await alice.request('/api/projects/personal')).json()) as { id: string }
    const flowId = await createFlow(alice, space.id)
    const runId = runIdOf(parseSse(await (await send(alice, flowId, '你好')).text()))
    expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({
      projectKind: 'personal',
      personalOwnerId: alice.userId,
    })
  })
})

describe('失权即 stop（docs/22 §5）', () => {
  it('发起人被移出项目：这张画布上的那一轮当场叫停（cancelled + 原因），他在别的画布上的照常跑完', async () => {
    const onShared = gated()
    const onOwn = gated()
    useFaux([onShared.step, onOwn.step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const shared = await createProject(alice)
    await joinViaInvite(alice, shared, bob)
    const sharedFlow = await createFlow(alice, shared)
    const ownFlow = await createFlow(bob, await createProject(bob, 'bob 自己的'))

    const first = send(bob, sharedFlow, '慢慢来')
    await onShared.reached
    const second = send(bob, ownFlow, '也慢慢来')
    await onOwn.reached

    const removed = await alice.request(`/api/projects/${shared}/members/${bob.userId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    const stopped = parseSse(await (await first).text())
    expect(stopped.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: ACCESS_REVOKED },
    })
    const stoppedRunId = runIdOf(stopped)
    expect(await db().findOneOrFail(AgentRun, stoppedRunId)).toMatchObject({ status: 'cancelled', error: ACCESS_REVOKED })
    // Grant 留下的是失权的原因，不被收尾时的「本轮已结束」盖掉
    expect(await db().findOneOrFail(AgentGrant, { runId: stoppedRunId })).toMatchObject({ revokeReason: ACCESS_REVOKED })
    // 模型只被请求过那一次：叫停不是「回给模型一个错误让它接着试」
    expect(onShared.calls()).toBe(1)

    // 另一张画布上的那一轮还在跑
    expect(agentAuthority.live().map((grant) => grant.flowId)).toEqual([ownFlow])
    onOwn.release()
    expect(parseSse(await (await second).text()).at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'success' },
    })
  })

  it('画布被删：那一轮当场叫停', async () => {
    const { step, reached } = gated()
    useFaux([step])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const res = send(alice, flowId, '慢慢来')
    await reached
    expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
    const events = parseSse(await (await res).text())
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'cancelled' }, result: { error: ACCESS_REVOKED } })
  })

  it('别的实例广播的撤销（订阅者收到通知）：重判后叫停', async () => {
    const { step, reached } = gated()
    useFaux([step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const res = send(bob, flowId, '慢慢来')
    await reached

    // 另一个实例改了权限：本实例的库里已经没有这条成员关系，只收到了撤销世代号变化的通知
    await db().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
    await notifyAccessRevoked()
    expect(parseSse(await (await res).text()).at(-1)).toMatchObject({ result: { error: ACCESS_REVOKED } })
  })

  it('没有撤销事件的失权：下一次判权（工具调用）就叫停整轮，模型不再被请求', async () => {
    let calls = 0
    let bobId = ''
    let projectId = ''
    // 不缓存判权结论：工具那一道一定重查（生产的缓存只有数秒，这里把它压到 0 好确定地观察）
    const authority = createGrantAuthority({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
    useFaux(
      [
        async () => {
          calls += 1
          // 模型这一步返回之前，发起人悄悄失权（没走 revokeCollabAccess）
          await db().nativeDelete(ProjectMember, { project: projectId, user: bobId })
          return fauxAssistantMessage([fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' })
        },
        () => {
          calls += 1
          return fauxAssistantMessage('不该走到这里')
        },
      ],
      { authorities: authority },
    )
    const alice = await actor('alice')
    const bob = await actor('bob')
    projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    bobId = bob.userId
    const flowId = await createFlow(alice, projectId)

    const events = parseSse(await (await send(bob, flowId, '读一下')).text())
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'cancelled' }, result: { error: ACCESS_REVOKED } })
    expect(calls).toBe(1)
    const runId = runIdOf(events)
    expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({ revokeReason: ACCESS_REVOKED })
    // 那次工具调用记了日志（失败），也带着 grantId
    const [call] = await db().find(AgentToolCall, { runId })
    expect(call).toMatchObject({ name: 'read_canvas', ok: false })
    expect(call?.grantId).toBeTruthy()
  })
})

describe('与登录态解耦（docs/22 §6）', () => {
  it('发起人退出登录、会话行全没了：这一轮照常跑完', async () => {
    const { step, release, reached } = gated()
    useFaux([step])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const res = send(alice, flowId, '我先下线了')
    await reached

    expect((await alice.request('/api/auth/logout')).status).toBe(302)
    await db().nativeDelete(Session, {})
    // 对账也不看会话
    await agentAuthority.reconcileAll()
    await notifyAccessRevoked()

    release()
    const events = parseSse(await (await res).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect(await db().findOneOrFail(AgentRun, runIdOf(events))).toMatchObject({ status: 'success' })
  })
})

describe('到期与定时对账', () => {
  it('Grant 到期：定时对账叫停这一轮，运行日志 expired，线上仍是 cancelled', async () => {
    let offset = 0
    const authority = createGrantAuthority({ expiryMarginMs: 0, entitled: () => true, now: () => Date.now() + offset })
    const { step, reached } = gated()
    useFaux([step], { authorities: authority, limits: { timeoutMs: 60_000 } })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const res = send(alice, flowId, '慢慢来')
    await reached
    await liveOn(flowId, authority)

    offset = 61_000
    await authority.reconcileAll()
    const events = parseSse(await (await res).text())
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: GRANT_EXPIRED },
    })
    const runId = runIdOf(events)
    expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ status: 'expired', error: GRANT_EXPIRED })
    expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({ revokeReason: GRANT_EXPIRED })
  })

  it('定时对账：悄悄失权（没发撤销事件）的那一轮被叫停；库里过期的孤儿 Grant 标成到期', async () => {
    const { step, reached } = gated()
    useFaux([step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const orphan = await agentGrants.create({
      userId: 'u-gone',
      runId: 'run_crashed',
      flowId: 'flow-gone',
      projectId: 'p-gone',
      projectKind: 'team',
      personalOwnerId: null,
      expiresAt: new Date(Date.now() - 1000),
      scopes: [],
    })

    const res = send(bob, flowId, '慢慢来')
    await reached
    await db().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
    await agentAuthority.reconcileAll()

    expect(parseSse(await (await res).text()).at(-1)).toMatchObject({ result: { error: ACCESS_REVOKED } })
    expect(await agentGrants.state(orphan)).toMatchObject({ revokeReason: GRANT_EXPIRED })
  })

  it('startAgentReconciler：按间隔跑全量对账，定时器不挡退出，停掉之后不再跑', async () => {
    const reconcileAll = vi.fn(async () => {})
    const stop = startAgentReconciler(15, { reconcileAll } as unknown as GrantAuthority)
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()
    const count = reconcileAll.mock.calls.length
    expect(count).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reconcileAll.mock.calls.length).toBe(count)
  })
})

describe('账号级撤销 revokeAllGrantsForUser', () => {
  it('停掉这个人在本实例的全部在跑轮次、撤销他库里全部有效的 Grant；别人的照常跑', async () => {
    const b1 = gated()
    const b2 = gated()
    const a1 = gated()
    useFaux([b1.step, b2.step, a1.step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const bobFlowOne = await createFlow(bob, await createProject(bob, '一'))
    const bobFlowTwo = await createFlow(bob, await createProject(bob, '二'))
    const aliceFlow = await createFlow(alice, await createProject(alice))
    const idle = await agentGrants.create({
      userId: bob.userId,
      runId: 'run_elsewhere',
      flowId: 'flow-elsewhere',
      projectId: 'p-elsewhere',
      projectKind: 'team',
      personalOwnerId: null,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [],
    })

    const one = send(bob, bobFlowOne, '一')
    await b1.reached
    const two = send(bob, bobFlowTwo, '二')
    await b2.reached
    const hers = send(alice, aliceFlow, '她的')
    await a1.reached

    expect(await revokeAllGrantsForUser(bob.userId, '账号已被封禁，agent 已停止')).toBe(2)
    for (const res of [one, two]) {
      expect(parseSse(await (await res).text()).at(-1)).toMatchObject({
        outcome: { type: 'cancelled' },
        result: { error: '账号已被封禁，agent 已停止' },
      })
    }
    // 别的实例上的（这里用一份没在本进程跑的 Grant 代替）也在库里撤销了
    expect(await agentGrants.state(idle)).toMatchObject({ revokeReason: '账号已被封禁，agent 已停止' })

    a1.release()
    expect(parseSse(await (await hers).text()).at(-1)).toMatchObject({ outcome: { type: 'success' } })
  })
})
