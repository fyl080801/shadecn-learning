import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { CollabServer, roomOf } from '@learning/collab'
import { parseAgentRunsMessage, type AgentRunEntry, type AgentStreamEvent } from '@learning/contracts/agent'
import { AGENT_RUNS_MESSAGE } from '@learning/contracts/collab'
import { expect, it } from 'vitest'
import { AgentLeases } from '../src/leases.js'
import { AgentRuns } from '../src/runs.js'
import { createFlow, createProject, describeOnBothDatabases, gated, joinViaInvite, tick, until } from './helpers.js'

/**
 * 运行中任务列表的房间广播（docs/20 §3.10.4）：一轮开始 / 结束时，生产那套宿主接线（`AGENT_HOST_OPTIONS`）经 Hocuspocus 的 `broadcastStateless` 把全量列表推给房间里的每条连接。
 * 「房间里的一条连接」用一个只实现 `messageAddress` + `send` 的假连接挂到活文档上：Hocuspocus 的 `broadcast` 只用这两样，所以测到的是真实的广播路径和线上字节。
 * 房间由一条 direct connection 撑着（相当于有人开着这张画布）。从 `apps/server/test/agent/runs-broadcast.test.ts` 移植。
 */

describeOnBothDatabases('运行中任务列表的房间广播', 'agent_broadcast', (ctx) => {
  const hocuspocus = () => ctx.app.get(CollabServer, { strict: false }).hocuspocus

  /**
   * 撑住房间并挂一条假连接，收下发给它的每一条 stateless 任务列表。
   * stateless 帧 = 地址（varString）+ 类型（varUint）+ 载荷（varString，最后一段）；房间名里没有 `{`，所以第一个 `{` 起就是载荷的 JSON。
   */
  async function listenToRoom(flowId: string) {
    const holder = await hocuspocus().openDirectConnection(roomOf(flowId), {})
    const document = hocuspocus().documents.get(roomOf(flowId))!
    const received: { flowId: string; runs: AgentRunEntry[]; now?: number }[] = []
    const fake = {
      messageAddress: roomOf(flowId),
      send(bytes: Uint8Array) {
        const text = new TextDecoder().decode(bytes)
        if (!text.includes(AGENT_RUNS_MESSAGE)) return
        const parsed = parseAgentRunsMessage(text.slice(text.indexOf('{')))
        if (parsed) received.push(parsed)
      },
    }
    document.addConnection(fake as never)
    return {
      received,
      async close() {
        document.removeConnection(fake as never)
        await holder.disconnect()
      },
    }
  }

  it('一轮开始（RUN_STARTED 之后）推一次含它的全量列表，结束推一次空列表；两个人的轮次都在同一份列表里', async () => {
    const aliceGate = gated()
    const bobGate = gated()
    const runtime = ctx.useScripted([aliceGate.step, bobGate.step])
    const alice = await ctx.actor('alice')
    const bob = await ctx.actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const room = await listenToRoom(flowId)

    try {
      const aliceRes = ctx.send(runtime, alice, flowId, '甲的任务')
      // 上游按请求到达的先后出步：等甲的模型请求到了再让乙发，脚本才对得上人
      await aliceGate.reached
      const bobRes = ctx.send(runtime, bob, flowId, '乙的任务')
      await bobGate.reached
      await tick()

      expect(room.received).toHaveLength(2)
      expect(room.received.every((message) => message.flowId === flowId)).toBe(true)
      expect(room.received[0]!.runs).toEqual([
        {
          runId: expect.any(String),
          conversationId: expect.any(String),
          conversationTitle: '甲的任务',
          owner: { id: alice.userId, name: 'alice', avatarUrl: null },
          startedAt: expect.any(Number),
          occupies: [],
          expiresAt: expect.any(Number),
        },
      ])
      // 载荷带着服务端时钟，前端据此换算 expiresAt（默认 TTL 30 秒）
      expect(room.received[0]!.now).toEqual(expect.any(Number))
      expect(room.received[0]!.runs[0]!.expiresAt! - room.received[0]!.now!).toBeGreaterThan(20_000)
      expect(room.received[1]!.runs.map((run) => [run.conversationTitle, run.owner.id])).toEqual([
        ['甲的任务', alice.userId],
        ['乙的任务', bob.userId],
      ])
      // 和 view 给的是同一份（去掉每个人自己算的 mine）
      const view = await runtime.view(flowId, bob.userId)
      expect(view.activeRuns.map(({ mine: _mine, ...run }) => run)).toEqual(room.received[1]!.runs)

      aliceGate.release()
      await aliceRes
      await until(() => room.received.at(-1)!.runs.length === 1, '甲的任务离开列表')
      expect(room.received.at(-1)!.runs.map((run) => run.owner.id)).toEqual([bob.userId])

      bobGate.release()
      await bobRes
      for (let i = 0; i < 100 && runtime.isRunning(flowId); i += 1) await tick()
      expect(room.received.map((message) => message.runs.length)).toEqual([1, 2, 1, 0])
    } finally {
      await room.close()
    }
  })

  it('占用（docs/20 §3.10.8）：agent 新建了节点 → 推一份带 occupies 的全量列表；一轮结束释放（共享层的登记表里也没了）', async () => {
    const hold = gated()
    const runtime = ctx.useScripted([fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '新的' }, data: { text: '正文' } })], { stopReason: 'toolUse' }), hold.step])
    const alice = await ctx.actor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const leases = ctx.app.get(AgentLeases, { strict: false })
    const room = await listenToRoom(flowId)
    try {
      const res = ctx.send(runtime, alice, flowId, '加一个')
      for (let i = 0; i < 150 && !room.received.some((message) => message.runs[0]?.occupies.length); i += 1) await tick()
      const occupied = room.received.find((message) => message.runs[0]?.occupies.length)!.runs[0]!.occupies
      expect(occupied).toHaveLength(1)
      expect((await leases.get(flowId, occupied[0]!))?.owner).toMatchObject({ id: alice.userId, name: 'alice' })
      hold.release()
      await res
      for (let i = 0; i < 100 && runtime.isRunning(flowId); i += 1) await tick()
      expect(room.received.at(-1)!.runs).toEqual([])
      expect(await leases.list(flowId)).toEqual(new Map())
    } finally {
      await room.close()
    }
  })

  it('一轮结束：任务登记、会话槽位都清掉（共享层里不留，别的副本也看不到它）', async () => {
    const hold = gated()
    const runtime = ctx.useScripted([hold.step])
    const alice = await ctx.actor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const runs = ctx.app.get(AgentRuns, { strict: false })
    const res = ctx.send(runtime, alice, flowId, '慢慢来')
    const [record] = await until(async () => {
      const listed = await runs.listRuns(flowId)
      return listed.length > 0 ? listed : null
    }, '任务进登记')
    expect(await runs.busyConversations(flowId)).toEqual(new Set([record!.conversationId]))
    hold.release()
    await res
    expect(await runs.listRuns(flowId)).toEqual([])
    expect(await runs.getSlot(flowId, record!.conversationId)).toBeNull()
    expect(await runs.busyConversations(flowId)).toEqual(new Set())
    expect(await runtime.activeRuns(flowId)).toEqual([])
    expect(runtime.liveRunIds().size).toBe(0)
  })

  it('准备会话就失败的一轮（续聊的会话不存在）不广播', async () => {
    const runtime = ctx.useScripted([fauxAssistantMessage('不该走到这')])
    const alice = await ctx.actor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const room = await listenToRoom(flowId)
    try {
      // 路由先 404 掉；直接走编排层，模拟「查过之后才被删」的窄窗口
      const out: AgentStreamEvent[] = []
      const started = await runtime.start({
        flowId,
        userId: alice.userId,
        conversationId: 'conv_gone',
        text: '续',
        openCanvas: async () => {
          throw new Error('不该打开画布')
        },
        emit: (event) => out.push(event),
      })
      if (started.ok) await started.done
      expect(out).toHaveLength(1)
      expect(room.received).toEqual([])
    } finally {
      await room.close()
    }
  })

  it('房间没加载（没人连着）就不发，也不抛', () => {
    expect(ctx.access.broadcastRuns('flow_nobody_here', [])).toBe(false)
  })
})
