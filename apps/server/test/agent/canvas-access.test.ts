import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { isAgentOrigin } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { defaultNodeData } from '@shadecn/shared/flow-graph'
import { createCanvasTools } from '@shadecn/agent/tools'
import { ACCESS_LOST, openAgentCanvas } from '../../agent/canvas-access.ts'
import { attachCollabServer, collabInstance } from '../../collab/hocuspocus.ts'
import { flushCollabWrites, loadFlowState, roomOf } from '../../collab/persistence.ts'
import { checkQuota, COLLAB_LIMITS, forgetQuota, HARD_LIMIT_FACTOR } from '../../collab/quota.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * agent 打开画布的那一层：真的起一个 Hocuspocus（不 listen，只用 direct connection），
 * 库是测试库。守的是 docs/20 §3.3 / §3.9 ② 那几条：
 * 写进活房间、origin 是 agent、关闭时落库、每次读写都重查权限、配额锁定时一个字节都不写。
 */

beforeAll(async () => {
  // 不 listen：direct connection 不经网络，attach 只是为了建出那个进程内的协同实例
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  await flushCollabWrites()
})

function addNode(id: string) {
  return (doc: Y.Doc) => {
    nodesMap(doc).set(id, toYNode({ id, type: 'text', position: { x: 0, y: 0 }, data: defaultNodeData(id) }))
  }
}

async function storedNodeIds(flowId: string): Promise<string[]> {
  const state = await loadFlowState(roomOf(flowId))
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, state)
  return [...nodesMap(doc).keys()].sort()
}

describe('openAgentCanvas', () => {
  it('写进活房间：在线的那份文档立刻可见，origin 是 agent；关闭时落库', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_1' })

    const live = collabInstance()!.documents.get(roomOf(flowId))!
    const origins: unknown[] = []
    live.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin))

    await canvas.write(addNode('n1'))
    expect(nodesMap(live).has('n1')).toBe(true)
    expect(origins).toHaveLength(1)
    expect(isAgentOrigin(origins[0])).toBe(true)
    expect(origins[0]).toEqual({ source: 'agent', runId: 'run_1' })

    await canvas.close()
    await flushCollabWrites()
    expect(await storedNodeIds(flowId)).toEqual(['n1'])
  })

  it('画布工具读得懂活房间里的文档 —— agent 包和 Hocuspocus 用的是同一份 yjs（instanceof 成立）', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_y' })
    await canvas.write(addNode('seeded'))

    const read = createCanvasTools({ canvas }).find((tool) => tool.name === 'read_canvas')!
    const res = await read.execute('call', {} as never)
    const snapshot = JSON.parse((res.content[0] as { text: string }).text) as { nodes: { id: string }[] }
    // yjs 一旦有两份，`value instanceof Y.Map` 永远为 false，这里会读出一张空图
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['seeded'])
    await canvas.close()
  })

  it('个人画布同样能开（所有者就是唯一成员）', async () => {
    const alice = await actor()
    const space = (await (await alice.request('/api/projects/personal')).json()) as { id: string }
    const flowId = await createFlow(alice, space.id)
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_p' })
    await canvas.write(addNode('p1'))
    await canvas.close()
    await flushCollabWrites()
    expect(await storedNodeIds(flowId)).toEqual(['p1'])
  })

  it('非成员打不开', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const flowId = await createFlow(alice, await createProject(alice))
    await expect(openAgentCanvas({ flowId, userId: bob.userId, runId: 'r' })).rejects.toThrow(ACCESS_LOST)
  })

  it('发起人中途被移出项目：下一次读写即被拒，文档不变', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const canvas = await openAgentCanvas({ flowId, userId: bob.userId, runId: 'run_b' })
    await canvas.write(addNode('ok'))

    const removed = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    await expect(canvas.write(addNode('late'))).rejects.toThrow(ACCESS_LOST)
    await expect(canvas.read(() => null)).rejects.toThrow(ACCESS_LOST)
    const live = collabInstance()!.documents.get(roomOf(flowId))!
    expect([...nodesMap(live).keys()]).toEqual(['ok'])
    await canvas.close()
  })

  it('画布被删：下一次写即被拒', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_d' })
    expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
    await expect(canvas.write(addNode('x'))).rejects.toThrow(ACCESS_LOST)
    await canvas.close()
  })

  it('房间顶到配额硬限：拒绝写入，一个字节都不写', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const room = roomOf(flowId)
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_q' })

    // 用一份超大的替身文档把这个房间名标成硬限锁定（判定按房间名记，和哪份文档无关）
    const huge = new Y.Doc()
    nodesMap(huge).set('big', toYNode({ id: 'big', type: 'text', position: { x: 0, y: 0 }, data: defaultNodeData('x') }))
    ;(nodesMap(huge).get('big')!.get('data') as Y.Map<unknown>).set(
      'text',
      'x'.repeat(Math.ceil(COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) + 1),
    )
    expect(checkQuota(room, huge)).toMatch(/硬限/)

    const live = collabInstance()!.documents.get(room)!
    const before = Y.encodeStateVector(live)
    await expect(canvas.write(addNode('x'))).rejects.toThrow('容量上限')
    expect(Y.encodeStateVector(live)).toEqual(before)

    forgetQuota(room)
    await canvas.close()
  })
})
