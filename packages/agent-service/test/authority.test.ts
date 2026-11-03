import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { AccessRevocation, Flow, Project, ProjectMember } from '@learning/canvas'
import { AgentEventType } from '@learning/contracts/agent'
import { DataAccess } from '@learning/data-access'
import { describe, expect, it, vi } from 'vitest'
import { ACCESS_LOST, ACCESS_REVOKED, type AgentAuthorities, AUTHORIZE_UNAVAILABLE, GRANT_EXPIRED } from '../src/authority.js'
import { AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from '../src/entities.js'
import { AgentGrants } from '../src/stores.js'
import { Session } from '../../session/src/entities.js'
import { createFlow, createProject, describeOnBothDatabases, gated, joinViaInvite, runIdOf, tick, until } from './helpers.js'

/**
 * 一轮 agent 的执行身份（docs/22）：真的发起（编排层的 `start`，第 6 步才有 HTTP 入口）、真的签 Grant 落进测试库、真的经 direct connection 写活房间。
 * 守的是：开始时签发 Grant（scope 落库、运行日志与工具调用日志带 grantId）；失权（移出项目 / 删画布）当场叫停这一轮、以 cancelled 收尾并写明原因，
 * 同一个人在别的画布上的照常跑；会话没了不影响；Grant 到期 → expired；定时对账（悄悄失权、孤儿 Grant）。从 `apps/server/test/agent/authority.test.ts` 移植。
 * 账号级撤销（`revokeAllGrantsForUser`）旧服务没有生产调用方，不搬（`docs/31` §4.4）。
 */

describeOnBothDatabases('Grant', 'agent_authority', (ctx) => {
  const db = () => ctx.app.get(DataAccess).em()
  const grants = () => ctx.app.get(AgentGrants, { strict: false })

  const liveOn = (flowId: string, authority: AgentAuthorities = ctx.authorities) => until(() => authority.live().find((grant) => grant.flowId === flowId), '这张画布上在跑的 Grant')

  describe('签发与审计', () => {
    it('开始时签发 Grant：scope 按发起人此刻的权限落库；运行日志、工具调用日志都带 grantId；结束时 Grant 关掉', async () => {
      const runtime = ctx.useScripted([
        fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '一' } })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('好了'),
      ])
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      const events = await ctx.send(runtime, alice, flowId, '加一个')
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
      const runId = runIdOf(events)

      const grant = await db().findOneOrFail(AgentGrant, { runId })
      expect(grant).toMatchObject({ userId: alice.userId, flowId, projectId, projectKind: 'team', personalOwnerId: null, revokeReason: '本轮已结束（完成）' })
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
      expect(ctx.authorities.live()).toEqual([])
    })

    it('个人画布：快照里记下所有者', async () => {
      const runtime = ctx.useScripted([fauxAssistantMessage('好')])
      const alice = await ctx.actor()
      const space = (await alice.request('/api/projects/personal')).json<{ id: string }>()
      const flowId = await createFlow(alice, space.id)
      const runId = runIdOf(await ctx.send(runtime, alice, flowId, '你好'))
      expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({ projectKind: 'personal', personalOwnerId: alice.userId })
    })

    it('非成员签不出 Grant', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const flowId = await createFlow(alice, await createProject(alice))
      await expect(ctx.authorities.issue({ runId: 'r', flowId, userId: bob.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 1000, stop: () => {} })).rejects.toThrow(ACCESS_LOST)
      expect(await db().count(AgentGrant, { runId: 'r' })).toBe(0)
    })

    it('没开媒体工具：请求 sandbox:exec 也不授，判权只拒这一次（不叫停）', async () => {
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const stops: string[] = []
      const authority = await ctx.authorities.issue({ runId: 'r_exec', flowId, userId: alice.userId, conversationId: 'c', capabilities: ['flow:read', 'sandbox:exec'], model: null, timeoutMs: 1000, stop: (_kind, reason) => stops.push(reason) })
      expect([...authority.scopes]).toEqual(['flow:read'])
      await expect(authority.authorize('sandbox:exec')).rejects.toThrow('这一轮没有被授予')
      await authority.authorize('flow:read')
      expect(stops).toEqual([])
      await authority.release({ status: 'success', reason: null })
    })
  })

  describe('失权即 stop（docs/22 §5）', () => {
    it('发起人被移出项目：这张画布上的那一轮当场叫停（cancelled + 原因），他在别的画布上的照常跑完', async () => {
      const onShared = gated()
      const onOwn = gated()
      const runtime = ctx.useScripted([onShared.step, onOwn.step])
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const shared = await createProject(alice)
      await joinViaInvite(alice, shared, bob)
      const sharedFlow = await createFlow(alice, shared)
      const ownFlow = await createFlow(bob, await createProject(bob, 'bob 自己的'))

      const first = ctx.send(runtime, bob, sharedFlow, '慢慢来')
      await onShared.reached
      const second = ctx.send(runtime, bob, ownFlow, '也慢慢来')
      await onOwn.reached

      const removed = await alice.request(`/api/projects/${shared}/members/${bob.userId}`, { method: 'DELETE' })
      expect(removed.status).toBe(204)

      const stopped = await first
      expect(stopped.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: ACCESS_REVOKED } })
      const stoppedRunId = runIdOf(stopped)
      expect(await db().findOneOrFail(AgentRun, stoppedRunId)).toMatchObject({ status: 'cancelled', error: ACCESS_REVOKED })
      // Grant 留下的是失权的原因，不被收尾时的「本轮已结束」盖掉
      expect(await db().findOneOrFail(AgentGrant, { runId: stoppedRunId })).toMatchObject({ revokeReason: ACCESS_REVOKED })
      // 模型只被请求过那一次：叫停不是「回给模型一个错误让它接着试」
      expect(onShared.calls()).toBe(1)

      // 另一张画布上的那一轮还在跑
      expect(ctx.authorities.live().map((grant) => grant.flowId)).toEqual([ownFlow])
      onOwn.release()
      expect((await second).at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    })

    it('画布被删：那一轮当场叫停', async () => {
      const { step, reached } = gated()
      const runtime = ctx.useScripted([step])
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const res = ctx.send(runtime, alice, flowId, '慢慢来')
      await reached
      expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await res).at(-1)).toMatchObject({ outcome: { type: 'cancelled' }, result: { error: ACCESS_REVOKED } })
    })

    it('别的实例广播的撤销（订阅者收到通知）：重判后叫停', async () => {
      const { step, reached } = gated()
      const runtime = ctx.useScripted([step])
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)
      const res = ctx.send(runtime, bob, flowId, '慢慢来')
      await reached

      // 另一个实例改了权限：本实例的库里已经没有这条成员关系，只收到了撤销世代号变化的通知
      await db().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
      await ctx.app.get(AccessRevocation, { strict: false }).notify()
      expect((await res).at(-1)).toMatchObject({ result: { error: ACCESS_REVOKED } })
    })

    it('没有撤销事件的失权：下一次判权（工具调用）就叫停整轮，模型不再被请求', async () => {
      let calls = 0
      let bobId = ''
      let projectId = ''
      // 不缓存判权结论：工具那一道一定重查（生产的缓存只有数秒，这里把它压到 0 好确定地观察）
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
      const runtime = ctx.useScripted(
        [
          async () => {
            calls += 1
            // 模型这一步返回之前，发起人悄悄失权（没走撤销信号）
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
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      bobId = bob.userId
      const flowId = await createFlow(alice, projectId)

      const events = await ctx.send(runtime, bob, flowId, '读一下')
      expect(events.at(-1)).toMatchObject({ outcome: { type: 'cancelled' }, result: { error: ACCESS_REVOKED } })
      expect(calls).toBe(1)
      const runId = runIdOf(events)
      expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({ revokeReason: ACCESS_REVOKED })
      // 那次工具调用记了日志（失败），也带着 grantId
      const [call] = await db().find(AgentToolCall, { runId })
      expect(call).toMatchObject({ name: 'read_canvas', ok: false })
      expect(call?.grantId).toBeTruthy()
    })

    it('画布挪到别的项目：发起人两边都是成员也算失权（快照对不上）', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const other = await createProject(alice, '另一个项目')
      const flowId = await createFlow(alice, projectId)
      const stops: string[] = []
      const issued = await authority.issue({ runId: 'r_move', flowId, userId: alice.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 60_000, stop: (_kind, reason) => stops.push(reason) })
      await issued.authorize('flow:read')

      await db().nativeUpdate(Flow, { id: flowId }, { project: other })
      await expect(issued.authorize('flow:read')).rejects.toThrow(ACCESS_REVOKED)
      expect(stops).toEqual([ACCESS_REVOKED])
      await issued.release({ status: 'cancelled', reason: ACCESS_REVOKED })
    })

    it('项目被删：判权失败（和 FlowMemberGuard 同口径，软删也算）', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      const issued = await authority.issue({ runId: 'r_gone', flowId, userId: alice.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 60_000, stop: () => {} })
      await db().nativeUpdate(Project, { id: projectId }, { deletedAt: new Date() })
      await expect(issued.authorize('flow:read')).rejects.toThrow(ACCESS_REVOKED)
      await issued.release({ status: 'cancelled', reason: ACCESS_REVOKED })
    })

    it('查不了库：只拒这一次、不叫停、不缓存，恢复后照常', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 60_000, entitled: () => true })
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const stops: string[] = []
      const issued = await authority.issue({ runId: 'r_db', flowId, userId: alice.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 60_000, stop: (_kind, reason) => stops.push(reason) })
      const state = vi.spyOn(grants(), 'state').mockRejectedValueOnce(new Error('库挂了'))
      await expect(issued.authorize('flow:read')).rejects.toThrow(AUTHORIZE_UNAVAILABLE)
      expect(stops).toEqual([])
      await tick(0)
      await issued.authorize('flow:read')
      state.mockRestore()
      await issued.release({ status: 'success', reason: null })
    })

    it('库里这一行被别的实例撤销了：下一次判权读到 revokedAt，叫停，原因是它写下的那个', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const stops: string[] = []
      const issued = await authority.issue({ runId: 'r_other', flowId, userId: alice.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 60_000, stop: (_kind, reason) => stops.push(reason) })
      await issued.authorize('flow:read')
      await grants().revoke(issued.grantId, '账号已被封禁')
      await expect(issued.authorize('flow:read')).rejects.toThrow('账号已被封禁')
      expect(stops).toEqual(['账号已被封禁'])
      await issued.release({ status: 'cancelled', reason: '账号已被封禁' })
    })

    it('判死之后每次判权都直接拒，不再查库', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 60_000, verdictTtlMs: 0, entitled: () => true })
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)
      const issued = await authority.issue({ runId: 'r_dead', flowId, userId: bob.userId, conversationId: 'c', capabilities: ['flow:read'], model: null, timeoutMs: 60_000, stop: () => {} })
      await db().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
      await expect(issued.authorize('flow:read')).rejects.toThrow(ACCESS_REVOKED)
      const state = vi.spyOn(grants(), 'state')
      await expect(issued.authorize('flow:read')).rejects.toThrow(ACCESS_REVOKED)
      expect(state).not.toHaveBeenCalled()
      state.mockRestore()
      await issued.release({ status: 'cancelled', reason: ACCESS_REVOKED })
    })
  })

  describe('与登录态解耦（docs/22 §6）', () => {
    it('发起人的会话行全没了：这一轮照常跑完', async () => {
      const { step, release, reached } = gated()
      const runtime = ctx.useScripted([step])
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const res = ctx.send(runtime, alice, flowId, '我先下线了')
      await reached

      await db().nativeDelete(Session, {})
      // 对账也不看会话
      await ctx.authorities.reconcileAll()
      await ctx.app.get(AccessRevocation, { strict: false }).notify()

      release()
      const events = await res
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
      expect(await db().findOneOrFail(AgentRun, runIdOf(events))).toMatchObject({ status: 'success' })
    })
  })

  describe('到期与定时对账', () => {
    it('Grant 到期：定时对账叫停这一轮，运行日志 expired，线上仍是 cancelled', async () => {
      let offset = 0
      const authority = ctx.authorityWith({ expiryMarginMs: 0, entitled: () => true, now: () => Date.now() + offset })
      const { step, reached } = gated()
      // Grant 的绝对过期按总时长上限算（docs/20 §3.10.11）
      const runtime = ctx.useScripted([step], { authorities: authority, limits: { timeoutMs: 60_000, totalTimeoutMs: 60_000 } })
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const res = ctx.send(runtime, alice, flowId, '慢慢来')
      await reached
      await liveOn(flowId, authority)

      offset = 61_000
      await authority.reconcileAll()
      const events = await res
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: GRANT_EXPIRED } })
      const runId = runIdOf(events)
      expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ status: 'expired', error: GRANT_EXPIRED })
      expect(await db().findOneOrFail(AgentGrant, { runId })).toMatchObject({ revokeReason: GRANT_EXPIRED })
    })

    it('定时对账：悄悄失权（没发撤销事件）的那一轮被叫停；库里过期的孤儿 Grant 标成到期', async () => {
      const { step, reached } = gated()
      const runtime = ctx.useScripted([step])
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)
      const orphan = await grants().create({ userId: 'u-gone', runId: 'run_crashed', flowId: 'flow-gone', projectId: 'p-gone', projectKind: 'team', personalOwnerId: null, expiresAt: new Date(Date.now() - 1000), scopes: [] })

      const res = ctx.send(runtime, bob, flowId, '慢慢来')
      await reached
      await db().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
      await ctx.authorities.reconcileAll()

      expect((await res).at(-1)).toMatchObject({ result: { error: ACCESS_REVOKED } })
      expect(await grants().state(orphan)).toMatchObject({ revokeReason: GRANT_EXPIRED })
    })

    it('已撤销的 Grant 第一个原因留下；没到期的不动', async () => {
      const id = await grants().create({ userId: 'u', runId: 'run_r', flowId: 'f', projectId: 'p', projectKind: 'team', personalOwnerId: null, expiresAt: new Date(Date.now() + 60_000), scopes: [] })
      expect(await grants().expireDue(GRANT_EXPIRED)).toBe(0)
      expect(await grants().revoke(id, '第一个原因')).toBe(true)
      expect(await grants().revoke(id, '第二个原因')).toBe(false)
      expect(await grants().state(id)).toMatchObject({ revokeReason: '第一个原因' })
    })

    it('定时对账按间隔跑，停掉之后不再跑；撤权订阅也一起撤', async () => {
      const authority = ctx.authorityWith({ expiryMarginMs: 0, entitled: () => true, reconcileIntervalMs: 15 })
      const reconcileAll = vi.spyOn(authority, 'reconcileAll').mockResolvedValue()
      const reconcileLive = vi.spyOn(authority, 'reconcileLive').mockResolvedValue()
      authority.onModuleInit()
      await tick(60)
      await ctx.app.get(AccessRevocation, { strict: false }).notify()
      expect(reconcileLive).toHaveBeenCalledTimes(1)
      authority.onModuleDestroy()
      const count = reconcileAll.mock.calls.length
      expect(count).toBeGreaterThan(0)
      await tick(50)
      expect(reconcileAll.mock.calls.length).toBe(count)
      await ctx.app.get(AccessRevocation, { strict: false }).notify()
      expect(reconcileLive).toHaveBeenCalledTimes(1)
    })
  })

})
