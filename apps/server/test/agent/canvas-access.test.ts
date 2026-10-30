import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'
import { IncomingMessage, MessageReceiver, OutgoingMessage, type Connection } from '@hocuspocus/server'
import { isAgentOrigin } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import type { CanvasTransaction } from '@shadecn/agent/canvas'
import { createCanvasTools } from '@shadecn/agent/tools'
import type { RunAuthority } from '@shadecn/agent/authority'
import { ACCESS_LOST, ACCESS_REVOKED, agentAuthority } from '../../agent/authority.ts'
import { CONNECTION_CLOSED, classifyCollabOrigin, openAgentCanvas } from '../../agent/canvas-access.ts'
import { replaceAgentRuntime } from '../../agent/index.ts'
import type { CollabContext } from '../../collab/hocuspocus.ts'
import { attachCollabServer, collabInstance } from '../../collab/hocuspocus.ts'
import { flushCollabWrites, loadFlowState, roomOf } from '../../collab/persistence.ts'
import { checkQuota, COLLAB_LIMITS, forgetQuota, HARD_LIMIT_FACTOR } from '../../collab/quota.ts'
import { useScripted } from '../helpers/agent.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * agent 打开画布的那一层：真的起一个 Hocuspocus（不 listen，只用 direct connection），
 * 库是测试库。守的是 docs/20 §3.3 / §3.9 ② 那几条：
 * 写进活房间、origin 是 agent、关闭时落库、每次读写都经这一轮的 authority 判权（docs/22，失权即叫停）、
 * 配额锁定时一个字节都不写。authority 用的是生产那份（`agent/authority.ts`，Grant 真的落进测试库）。
 */

beforeAll(async () => {
  // 不 listen：direct connection 不经网络，attach 只是为了建出那个进程内的协同实例
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

/** 这个文件里签发的 Grant：用例结束时收尾，免得留在进程的对账表里 */
const issued: RunAuthority[] = []

afterEach(async () => {
  await Promise.all(issued.splice(0).map((authority) => authority.release({ status: 'success', reason: null })))
  await flushCollabWrites()
})

/** 给 (画布, 发起人, run) 签一份真的 Grant；`stops` 记下对账叫停这一轮时给的原因 */
async function grantFor(flowId: string, userId: string, runId: string) {
  const stops: string[] = []
  const authority = await agentAuthority.issue({
    runId,
    flowId,
    userId,
    conversationId: 'conv',
    capabilities: ['flow:read', 'flow:write', 'flow:delete'],
    model: null,
    timeoutMs: 60_000,
    stop: (_kind, reason) => stops.push(reason),
  })
  issued.push(authority)
  return { authority, stops }
}

async function open(flowId: string, userId: string, runId: string) {
  const { authority, stops } = await grantFor(flowId, userId, runId)
  const canvas = await openAgentCanvas({ flowId, userId, runId, authority })
  return Object.assign(canvas, { stops })
}

function addNode(id: string) {
  return (doc: Y.Doc) => {
    nodesMap(doc).set(id, toYNode(buildNodeRecord({ id, type: 'text', label: id, position: { x: 0, y: 0 } })))
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
    const canvas = await open(flowId, alice.userId, 'run_1')

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
    const canvas = await open(flowId, alice.userId, 'run_y')
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
    const canvas = await open(flowId, alice.userId, 'run_p')
    await canvas.write(addNode('p1'))
    await canvas.close()
    await flushCollabWrites()
    expect(await storedNodeIds(flowId)).toEqual(['p1'])
  })

  it('非成员签不出 Grant；判权不过的 authority 打不开画布（不开房间）', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const flowId = await createFlow(alice, await createProject(alice))
    await expect(grantFor(flowId, bob.userId, 'r')).rejects.toThrow(ACCESS_LOST)

    const deny = { authorize: async () => Promise.reject(new Error('不许')) }
    await expect(openAgentCanvas({ flowId, userId: bob.userId, runId: 'r2', authority: deny })).rejects.toThrow('不许')
    expect(collabInstance()!.documents.has(roomOf(flowId))).toBe(false)
  })

  it('读判 flow:read、写判 flow:write', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const calls: string[] = []
    const authority = { authorize: async (capability: string) => void calls.push(capability) }
    const canvas = await openAgentCanvas({ flowId, userId: alice.userId, runId: 'run_caps', authority })
    await canvas.read(() => null)
    await canvas.write(addNode('c'))
    expect(calls).toEqual(['flow:read', 'flow:read', 'flow:write'])
    await canvas.close()
  })

  it('发起人中途被移出项目：下一次读写即被拒，文档不变', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const canvas = await open(flowId, bob.userId, 'run_b')
    await canvas.write(addNode('ok'))

    const removed = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    // 移除成员的路由 await 了撤销事件：204 时对账已经把这一轮叫停了
    expect(canvas.stops).toEqual([ACCESS_REVOKED])

    await expect(canvas.write(addNode('late'))).rejects.toThrow(ACCESS_REVOKED)
    await expect(canvas.read(() => null)).rejects.toThrow(ACCESS_REVOKED)
    const live = collabInstance()!.documents.get(roomOf(flowId))!
    expect([...nodesMap(live).keys()]).toEqual(['ok'])
    await canvas.close()
  })

  it('画布被删：下一次写即被拒', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const canvas = await open(flowId, alice.userId, 'run_d')
    expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
    expect(canvas.stops).toEqual([ACCESS_REVOKED])
    await expect(canvas.write(addNode('x'))).rejects.toThrow(ACCESS_REVOKED)
    await canvas.close()
  })

  it('房间顶到配额硬限：拒绝写入，一个字节都不写', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const room = roomOf(flowId)
    const canvas = await open(flowId, alice.userId, 'run_q')

    // 用一份超大的替身文档把这个房间名标成硬限锁定（判定按房间名记，和哪份文档无关）
    const huge = new Y.Doc()
    nodesMap(huge).set('big', toYNode(buildNodeRecord({ id: 'big', type: 'text', label: 'x', position: { x: 0, y: 0 } })))
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

/**
 * 用 Hocuspocus 自己的消息处理把一份 update 当作「某条客户端连接发来的」应用到活文档上 ——
 * 走的是 `MessageReceiver.readSyncMessage` → `readUpdate(…, { source: 'connection', connection })` 那条真实路径，
 * origin 由 Hocuspocus 自己构造（docs/20 §3.10.2 记的实测结论）。假连接只实现这条路径会碰到的几样。
 */
async function applyAsClient(document: Y.Doc & { name: string }, context: CollabContext, change: (doc: Y.Doc) => void) {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document))
  const before = Y.encodeStateVector(scratch)
  change(scratch)
  const update = Y.encodeStateAsUpdate(scratch, before)
  const bytes = new OutgoingMessage(document.name).createSyncMessage().writeUpdate(update).toUint8Array()
  const message = new IncomingMessage(bytes)
  message.readVarString() // 文档名（ClientConnection 先读掉它）
  const connection = {
    context,
    readOnly: false,
    messageAddress: document.name,
    callbacks: { beforeSync: async () => {} },
    send: () => {},
  } as unknown as Connection
  await new MessageReceiver(message).apply(document as never, connection)
}

describe('一轮一条连接与常驻观察（docs/20 §3.10.2）', () => {
  afterEach(() => {
    replaceAgentRuntime(null)
    vi.restoreAllMocks()
  })

  it('一轮只开一条 direct connection：几次工具调用共用，期间房间不卸载；收尾时关掉、房间随之卸载', async () => {
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const room = roomOf(flowId)
    const hocuspocus = collabInstance()!
    const opens = vi.spyOn(hocuspocus, 'openDirectConnection')
    const connectionsDuringRun: number[] = []

    const runtime = useScripted([
      fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '一' } })], { stopReason: 'toolUse' }),
      () => {
        connectionsDuringRun.push(hocuspocus.documents.get(room)?.getConnectionsCount() ?? -1)
        return fauxAssistantMessage([fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('好了'),
    ])
    const started = runtime.start({
      flowId,
      userId: alice.userId,
      conversationId: null,
      text: '加一个',
      openCanvas: (runId, authority) => openAgentCanvas({ flowId, userId: alice.userId, runId, authority }),
      emit: () => {},
    })
    if (!started.ok) throw new Error('应该启动成功')
    await started.done

    expect(opens).toHaveBeenCalledTimes(1)
    expect(connectionsDuringRun).toEqual([1])
    expect(hocuspocus.documents.has(room)).toBe(false)
    await flushCollabWrites()
    expect((await storedNodeIds(flowId)).length).toBe(1)
  })

  it('常驻连接上权限照样每次复核：中途失权，下一次读写即被拒；关掉之后再读写是「连接已断开」', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)
    const canvas = await open(flowId, bob.userId, 'run_keep')
    await canvas.write(addNode('a'))
    await canvas.read(() => null)
    expect((await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })).status).toBe(204)
    await expect(canvas.read(() => null)).rejects.toThrow(ACCESS_REVOKED)
    await canvas.close()

    const again = await open(flowId, alice.userId, 'run_closed')
    await again.close()
    await expect(again.read(() => null)).rejects.toThrow(CONNECTION_CLOSED)
  })

  it('观察：客户端连接的更新报成那条连接上的人（Hocuspocus 构造的 origin）；本轮 / 别的轮次按 runId；redis 转发与认不出的 → unknown；gc 不报', async () => {
    const alice = await actor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const canvas = await open(flowId, alice.userId, 'run_me')
    const seen: CanvasTransaction[] = []
    const stop = canvas.observe!((change) => seen.push(change))
    const live = collabInstance()!.documents.get(roomOf(flowId))!

    const identity = { id: 'u-bob', name: '鲍勃', avatarUrl: null }
    await applyAsClient(live, { identity }, addNode('from-bob'))
    await canvas.write(addNode('mine'))
    live.transact(() => addNode('other-run')(live), { source: 'agent', runId: 'run_other' })
    live.transact(() => addNode('via-redis')(live), { source: 'redis' })
    live.transact(() => nodesMap(live).delete('via-redis'), 'gc')
    // 没登录（identity 为 null）的连接：认不出是谁
    await applyAsClient(live, { identity: null }, addNode('anon'))

    expect(seen.map((change) => [change.actor, [...change.nodeIds]])).toEqual([
      [{ kind: 'user', id: 'u-bob', name: '鲍勃' }, ['from-bob']],
      [{ kind: 'agent', runId: 'run_me' }, ['mine']],
      [{ kind: 'agent', runId: 'run_other' }, ['other-run']],
      [{ kind: 'unknown' }, ['via-redis']],
      [{ kind: 'unknown' }, ['anon']],
    ])
    stop()
    await canvas.close()
  })

  it('classifyCollabOrigin：内务 origin（gc / migrate）不算谁的改动', () => {
    expect(classifyCollabOrigin('gc')).toBeNull()
    expect(classifyCollabOrigin('migrate')).toBeNull()
    expect(classifyCollabOrigin('persistence')).toEqual({ kind: 'unknown' })
    expect(classifyCollabOrigin({ source: 'local', context: {} })).toEqual({ kind: 'unknown' })
  })
})
