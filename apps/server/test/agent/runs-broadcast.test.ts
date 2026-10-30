import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@mariozechner/pi-ai'
import type { ScriptedStep } from '@shadecn/agent/testing'
import type { Document } from '@hocuspocus/server'
import { agentApiPath, parseAgentRunsMessage, type AgentRunEntry } from '@shadecn/shared/agent'
import { AGENT_RUNS_MESSAGE } from '@shadecn/shared/collab'
import { agentRuntime, replaceAgentRuntime } from '../../agent/index.ts'
import { broadcastAgentRuns } from '../../agent/runs-broadcast.ts'
import { attachCollabServer, collabInstance } from '../../collab/hocuspocus.ts'
import { flushCollabWrites, roomOf } from '../../collab/persistence.ts'
import { useScripted } from '../helpers/agent.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * 运行中任务列表的房间广播（docs/20 §3.10.4）：一轮开始 / 结束时，生产那套宿主接线（`agentHostOptions`）
 * 经 Hocuspocus 的 `broadcastStateless` 把全量列表推给房间里的每条连接。
 *
 * 「房间里的一条连接」用一个只实现 `messageAddress` + `send` 的假连接挂到活文档上 ——
 * Hocuspocus 的 `broadcast` 只用这两样，所以测到的是真实的广播路径和线上字节，不是对 `broadcastStateless` 的 spy。
 * 房间由一条 direct connection 撑着（相当于有人开着这张画布），不然 agent 发 RUN_STARTED 时房间可能还没加载。
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function gated() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(fauxAssistantMessage('完成')))
    })
  return { step, release }
}

function useFaux(responses: ScriptedStep[]) {
  return useScripted(responses)
}

/**
 * 撑住房间并挂一条假连接，收下发给它的每一条 stateless 任务列表。
 * stateless 帧 = 地址（varString）+ 类型（varUint）+ 载荷（varString，最后一段）；房间名里没有 `{`，
 * 所以第一个 `{` 起就是载荷的 JSON。
 */
async function listenToRoom(flowId: string) {
  const holder = await collabInstance()!.openDirectConnection(roomOf(flowId), {})
  const document = collabInstance()!.documents.get(roomOf(flowId)) as Document
  const received: { flowId: string; runs: AgentRunEntry[] }[] = []
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

describe('运行中任务列表的房间广播', () => {
  it('一轮开始（RUN_STARTED 之后）推一次含它的全量列表，结束推一次空列表；两个人的轮次都在同一份列表里', async () => {
    const aliceGate = gated()
    const bobGate = gated()
    const runtime = useFaux([aliceGate.step, bobGate.step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const room = await listenToRoom(flowId)

    try {
      const aliceRes = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '甲的任务' })
      await tick()
      const bobRes = await bob.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '乙的任务' })
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
        },
      ])
      expect(room.received[1]!.runs.map((run) => [run.conversationTitle, run.owner.id])).toEqual([
        ['甲的任务', alice.userId],
        ['乙的任务', bob.userId],
      ])
      // 和 GET 给的是同一份（去掉每个人自己算的 mine）
      const view = (await (await bob.request(agentApiPath(flowId))).json()) as { activeRuns: (AgentRunEntry & { mine: boolean })[] }
      expect(view.activeRuns.map(({ mine: _mine, ...run }) => run)).toEqual(room.received[1]!.runs)

      aliceGate.release()
      await aliceRes.text()
      await tick()
      expect(room.received.at(-1)!.runs.map((run) => run.owner.id)).toEqual([bob.userId])

      bobGate.release()
      await bobRes.text()
      for (let i = 0; i < 100 && runtime.isRunning(flowId); i += 1) await tick()
      expect(room.received.map((message) => message.runs.length)).toEqual([1, 2, 1, 0])
    } finally {
      await room.close()
    }
  })

  it('准备会话就失败的一轮（续聊的会话不存在）不广播', async () => {
    useFaux([fauxAssistantMessage('不该走到这')])
    const alice = await actor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const room = await listenToRoom(flowId)
    try {
      // 路由先 404 掉；直接走编排层，模拟「查过之后才被删」的窄窗口
      const out: unknown[] = []
      const started = agentRuntime().start({
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
    expect(broadcastAgentRuns('flow_nobody_here', [])).toBe(false)
    expect(broadcastAgentRuns('flow_x', [], null)).toBe(false)
  })
})
