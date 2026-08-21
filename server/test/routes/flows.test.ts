import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { app } from '../../app.ts'
import { nodesMap } from '../../collab/flow-doc.ts'
import { emptyGraph, type FlowGraph } from '../../store/flow-types.ts'
import { closeRoom, openRoom, resetRooms, writeGraph } from '../helpers/collab.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite, type Actor } from '../helpers/project.ts'

beforeEach(async () => {
  await resetDb()
  // 房间是进程级的内存状态，不清会把上一个用例的内容带进来
  resetRooms()
})

afterEach(() => {
  resetRooms()
})

/** 取某个节点的 data 那层 Y.Map —— 并发合并的粒度就在这一层 */
function dataOf(doc: Y.Doc, nodeId: string): Y.Map<unknown> {
  return nodesMap(doc).get(nodeId)!.get('data') as Y.Map<unknown>
}

/** 造一张有 n 个节点、n-1 条边的图 */
function graphWith(nodeCount: number): FlowGraph {
  const graph = emptyGraph()
  for (let i = 0; i < nodeCount; i += 1) {
    graph.nodes.push({
      id: `n${i}`,
      type: 'process',
      position: { x: i * 100, y: 0 },
      data: { label: `节点 ${i}`, status: 'idle' },
    })
    if (i > 0) {
      graph.edges.push({
        id: `e${i}`,
        source: `n${i - 1}`,
        target: `n${i}`,
        data: {},
      })
    }
  }
  return graph
}

describe('GET /api/projects/:id/flows', () => {
  it('列表响应里没有 graph 字段', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    await createFlow(alice, projectId)

    const res = await alice.request(`/api/projects/${projectId}/flows`)
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).not.toHaveProperty('graph')
  })

  it('分页与关键字过滤', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    await createFlow(alice, projectId, '订单流程')
    await createFlow(alice, projectId, '退货流程')
    await createFlow(alice, projectId, '结算')

    const paged = await alice.request(`/api/projects/${projectId}/flows?page=1&pageSize=2`)
    await expect(paged.json()).resolves.toMatchObject({ total: 3, totalPages: 2 })

    const filtered = await alice.request(`/api/projects/${projectId}/flows?keyword=流程`)
    await expect(filtered.json()).resolves.toMatchObject({ total: 2 })
  })

  it('非法的 sort / status / pageSize → 400', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    expect((await alice.request(`/api/projects/${projectId}/flows?sort=size:asc`)).status).toBe(400)
    expect((await alice.request(`/api/projects/${projectId}/flows?status=unknown`)).status).toBe(400)
    expect((await alice.request(`/api/projects/${projectId}/flows?pageSize=101`)).status).toBe(400)
  })

  it('软删的画布不再出现', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })

    const res = await alice.request(`/api/projects/${projectId}/flows`)
    await expect(res.json()).resolves.toMatchObject({ total: 0 })
  })
})

describe('画布的访问权来自项目成员身份', () => {
  it('另一个项目的成员访问 → 404', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const aProject = await createProject(alice, 'A')
    const flowId = await createFlow(alice, aProject)
    await createProject(bob, 'B')

    expect((await bob.request(`/api/flows/${flowId}`)).status).toBe(404)
    expect((await bob.json(`/api/flows/${flowId}`, 'PATCH', { name: 'x' })).status).toBe(404)
    expect((await bob.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('同项目的 member 能读能写（成员之间平权，跟谁建的无关）', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    expect((await bob.request(`/api/flows/${flowId}`)).status).toBe(200)
    expect((await bob.json(`/api/flows/${flowId}`, 'PATCH', { name: 'bob 改的' })).status).toBe(200)
  })

  it('被移出项目后立刻访问不到画布', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
    expect((await bob.request(`/api/flows/${flowId}`)).status).toBe(404)
  })

  it('未登录 → 401', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect((await app.request(`/api/flows/${flowId}`)).status).toBe(401)
  })
})

describe('画布内容的写入路径（Yjs）', () => {
  it('房间散场后内容落库，派生的快照与统计一起更新', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await writeGraph(flowId, graphWith(3))

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      revision: number
      nodeCount: number
      edgeCount: number
      graph: FlowGraph
    }
    expect(detail.nodeCount).toBe(3)
    expect(detail.edgeCount).toBe(2)
    expect(detail.graph.nodes.map((node) => node.id)).toEqual(['n0', 'n1', 'n2'])
    // revision 不再是乐观锁，只是服务端写入次数的单调计数
    expect(detail.revision).toBe(1)

    const row = await prisma.flow.findUniqueOrThrow({ where: { id: flowId } })
    expect(row.ydoc).not.toBeNull()
    expect(row.ydoc!.length).toBeGreaterThan(0)
  })

  it('重新打开时从 ydoc 恢复，内容不丢', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await writeGraph(flowId, graphWith(2))
    // 房间已经拆了；再开一次相当于服务端重启后有人重新访问
    const doc = await openRoom(flowId)
    expect([...doc.getMap('nodes').keys()].sort()).toEqual(['n0', 'n1'])
    await closeRoom(flowId)
  })

  it('老画布的 graph JSON 在第一次打开时自动迁进 ydoc', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    // 直接写库，模拟 Yjs 之前留下的数据：有 graph、没有 ydoc
    await prisma.flow.update({
      where: { id: flowId },
      data: { graph: JSON.stringify(graphWith(2)), ydoc: null, nodeCount: 2, edgeCount: 1 },
    })

    const doc = await openRoom(flowId)
    expect([...doc.getMap('nodes').keys()].sort()).toEqual(['n0', 'n1'])
    expect([...doc.getMap('edges').keys()]).toEqual(['e1'])
    await closeRoom(flowId)

    expect((await prisma.flow.findUniqueOrThrow({ where: { id: flowId } })).ydoc).not.toBeNull()
  })

  it('节点 data 上平铺的任意业务字段原样存取', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const business = { 嵌套: { 数组: [1, '二', null], 布尔: true }, 空对象: {}, prompt: '一只猫' }
    const graph = graphWith(1)
    Object.assign(graph.nodes[0]!.data, business)

    await writeGraph(flowId, graph)

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      graph: FlowGraph
    }
    expect(detail.graph.nodes[0]!.data).toMatchObject(business)
  })

  it('两个客户端并发改同一个节点的不同字段，两边的改动都留下', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    await writeGraph(flowId, graphWith(1))

    // 各自从同一份状态出发，离线改不同字段，再互相合并 —— CRDT 的核心保证
    const left = await openRoom(flowId)
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))

    dataOf(left, 'n0').set('label', '甲改的标题')
    dataOf(right, 'n0').set('description', '乙写的说明')

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    await closeRoom(flowId)

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      graph: FlowGraph
    }
    expect(detail.graph.nodes[0]!.data.label).toBe('甲改的标题')
    expect(detail.graph.nodes[0]!.data.description).toBe('乙写的说明')
  })
})

describe('POST /api/flows/:id/duplicate', () => {
  it('复制内容但不复制操作日志，revision 从 0 起', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId, '原始画布')

    await writeGraph(flowId, graphWith(2))

    const res = await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')
    expect(res.status).toBe(201)
    const copy = (await res.json()) as { id: string; name: string; revision: number; graph: FlowGraph }

    expect(copy.name).toBe('原始画布 副本')
    expect(copy.revision).toBe(0)
    expect(copy.graph.nodes).toHaveLength(2)
  })
})

describe('PATCH /api/flows/:id/user-state', () => {
  /** 取详情里那份「我自己的」状态 */
  async function userStateOf(who: Actor, flowId: string) {
    const res = await who.request(`/api/flows/${flowId}`)
    const body = (await res.json()) as { userState: Record<string, unknown> }
    return body.userState
  }

  it('存下来的视口只回给存它的人，别人看到的是自己的', async () => {
    const alice = await actor()
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const res = await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 10, y: 20, zoom: 1.5 },
    })
    expect(res.status).toBe(204)

    expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 10, y: 20, zoom: 1.5 } })
    // bob 还没存过：拿到空对象，由前端回落到快照里那份兜底视口
    expect(await userStateOf(bob, flowId)).toEqual({})

    await bob.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: -5, y: 0, zoom: 0.5 },
    })
    expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 10, y: 20, zoom: 1.5 } })
    expect(await userStateOf(bob, flowId)).toEqual({ viewport: { x: -5, y: 0, zoom: 0.5 } })
  })

  it('再存一次是覆盖，一个人一张画布只有一行', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 1, y: 1, zoom: 1 },
    })
    await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 2, y: 2, zoom: 2 },
    })

    expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 2, y: 2, zoom: 2 } })
    expect(await prisma.flowUserState.count({ where: { flowId } })).toBe(1)
  })

  it('视图操作不动画布数据：revision 不涨', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 3, y: 4, zoom: 1 },
    })

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      revision: number
      graph: FlowGraph
    }
    expect(detail.revision).toBe(0)
    // 快照里那份兜底视口没被个人视口改写
    expect(detail.graph.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('校验：未知分区、坏视口、空 body → 400', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const patch = (body: unknown) => alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', body)

    expect((await patch({ 谁知道呢: 1 })).status).toBe(400)
    expect((await patch({ viewport: { x: 1, y: 2 } })).status).toBe(400)
    expect((await patch({ viewport: { x: 1, y: 2, zoom: 0 } })).status).toBe(400)
    expect((await patch({ viewport: { x: 1, y: 2, zoom: Number.NaN } })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
  })

  it('非成员存不了：跟读一样是 404，不泄露画布存不存在', async () => {
    const alice = await actor()
    const stranger = await actor('stranger')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const res = await stranger.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 1, y: 1, zoom: 1 },
    })
    expect(res.status).toBe(404)
    expect(await prisma.flowUserState.count({ where: { flowId } })).toBe(0)
  })

  it('画布删掉，附带的用户状态一起没', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', {
      viewport: { x: 1, y: 1, zoom: 1 },
    })
    // 软删只是过滤，行还在；真正的级联删除靠外键，这里直接删库里那行画布
    await prisma.flow.delete({ where: { id: flowId } })

    expect(await prisma.flowUserState.count({ where: { flowId } })).toBe(0)
  })
})
