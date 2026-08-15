import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app.ts'
import { emptyGraph, type FlowGraph } from '../../store/flow-types.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, joinViaInvite, type Actor } from '../helpers/project.ts'

beforeEach(async () => {
  await resetDb()
})

/** 造一张有 n 个节点、n-1 条边的图 */
function graphWith(nodeCount: number): FlowGraph {
  const graph = emptyGraph()
  for (let i = 0; i < nodeCount; i += 1) {
    graph.nodes.push({
      id: `n${i}`,
      type: 'process',
      position: { x: i * 100, y: 0 },
      data: { label: `节点 ${i}`, kind: 'process', config: {}, ports: { inputs: [], outputs: [] } },
    })
    if (i > 0) {
      graph.edges.push({
        id: `e${i}`,
        source: `n${i - 1}`,
        target: `n${i}`,
        data: { config: {} },
      })
    }
  }
  return graph
}

function transaction(id: string, label = '新增节点', ts = Date.now()) {
  return {
    id,
    label,
    kind: 'do' as const,
    ts,
    ops: [{ type: 'node.add', targetId: 'n0', before: null, after: { id: 'n0' } }],
  }
}

async function commit(
  who: Actor,
  flowId: string,
  body: { baseRevision: number; transactions: unknown[]; graph: FlowGraph },
) {
  return who.json(`/api/flows/${flowId}/commit`, 'POST', body)
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

describe('POST /api/flows/:id/commit', () => {
  it('提交后 revision 递增、快照与统计一起更新', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const res = await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1')],
      graph: graphWith(3),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ revision: 1 })

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      revision: number
      nodeCount: number
      edgeCount: number
      graph: FlowGraph
    }
    expect(detail).toMatchObject({ revision: 1, nodeCount: 3, edgeCount: 2 })
    expect(detail.graph.nodes).toHaveLength(3)
  })

  it('一次提交多个事务，revision 按事务条数递增，日志 seq 连续', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1'), transaction('tx-2'), transaction('tx-3')],
      graph: graphWith(1),
    })

    const rows = await prisma.flowOperation.findMany({
      where: { flowId },
      orderBy: { seq: 'asc' },
    })
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3])
    expect(rows.map((row) => row.txId)).toEqual(['tx-1', 'tx-2', 'tx-3'])
  })

  it('baseRevision 对不上 → 409，并带回服务端当前 revision', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1')],
      graph: graphWith(1),
    })

    const stale = await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-2')],
      graph: graphWith(2),
    })

    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ reason: 'conflict', revision: 1 })

    // 冲突的那次不能落库
    expect(await prisma.flowOperation.count({ where: { flowId } })).toBe(1)
  })

  it('同一个 txId 重复提交是幂等的（网络重试）', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const body = {
      baseRevision: 0,
      transactions: [transaction('tx-retry')],
      graph: graphWith(2),
    }
    const first = await commit(alice, flowId, body)
    const retry = await commit(alice, flowId, body)

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toEqual({ revision: 1 })
    expect(await prisma.flowOperation.count({ where: { flowId, txId: 'tx-retry' } })).toBe(1)
  })

  it('校验：baseRevision / transactions / 未知操作类型', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    const graph = graphWith(1)

    const bad = async (body: unknown) =>
      (await alice.json(`/api/flows/${flowId}/commit`, 'POST', body)).status

    expect(await bad({ baseRevision: -1, transactions: [transaction('t')], graph })).toBe(400)
    expect(await bad({ baseRevision: 0, transactions: [], graph })).toBe(400)
    expect(
      await bad({
        baseRevision: 0,
        graph,
        transactions: [
          { id: 't', label: 'x', ops: [{ type: 'node.explode', targetId: 'n0' }] },
        ],
      }),
    ).toBe(400)
  })

  it('时间戳落库：clientTs 用客户端上报的，serverTs 由服务端盖章', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const clientTs = Date.parse('2026-01-01T00:00:00.000Z')
    const before = Date.now()
    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1', '新增节点', clientTs)],
      graph: graphWith(1),
    })

    const row = await prisma.flowOperation.findFirstOrThrow({ where: { flowId, txId: 'tx-1' } })
    expect(Number(row.clientTs)).toBe(clientTs)
    // 服务端时间不听客户端的：即便客户端的钟停在去年，落库时刻还是现在
    expect(Number(row.serverTs)).toBeGreaterThanOrEqual(before)
    expect(Number(row.serverTs)).toBeLessThanOrEqual(Date.now())
  })

  it('ts 不是时间戳 → 400；不带 ts 的老客户端按收到的时刻补', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    const graph = graphWith(1)

    const bad = await alice.json(`/api/flows/${flowId}/commit`, 'POST', {
      baseRevision: 0,
      graph,
      transactions: [{ ...transaction('tx-bad'), ts: '2026-01-01T00:00:00.000Z' }],
    })
    expect(bad.status).toBe(400)

    const legacy = transaction('tx-legacy') as Record<string, unknown>
    delete legacy.ts
    const res = await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [legacy],
      graph,
    })
    expect(res.status).toBe(200)

    const row = await prisma.flowOperation.findFirstOrThrow({ where: { flowId, txId: 'tx-legacy' } })
    expect(Number(row.clientTs)).toBeGreaterThan(0)
  })

  it('graph 结构非法 → 400：未知版本、id 重复、边指向不存在的节点', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const bad = async (graph: unknown) =>
      (
        await alice.json(`/api/flows/${flowId}/commit`, 'POST', {
          baseRevision: 0,
          transactions: [transaction('t')],
          graph,
        })
      ).status

    expect(await bad({ ...graphWith(1), schemaVersion: 99 })).toBe(400)

    const duplicated = graphWith(1)
    duplicated.nodes.push({ ...duplicated.nodes[0]! })
    expect(await bad(duplicated)).toBe(400)

    const dangling = graphWith(1)
    dangling.edges.push({ id: 'e-x', source: 'n0', target: '不存在', data: { config: {} } })
    expect(await bad(dangling)).toBe(400)
  })

  it('节点 data.config 里的任意结构原样存取', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    const graph = graphWith(1)
    const config = {
      method: 'POST',
      retry: { times: 3, backoff: [1, 2, 4] },
      nested: { deep: { flag: true, nothing: null } },
    }
    graph.nodes[0]!.data.config = config

    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1')],
      graph,
    })

    const detail = (await (await alice.request(`/api/flows/${flowId}`)).json()) as {
      graph: FlowGraph
    }
    expect(detail.graph.nodes[0]!.data.config).toEqual(config)
  })
})

describe('POST /api/flows/:id/duplicate', () => {
  it('复制内容但不复制操作日志，revision 从 0 起', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId, '原始画布')

    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1')],
      graph: graphWith(2),
    })

    const res = await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')
    expect(res.status).toBe(201)
    const copy = (await res.json()) as { id: string; name: string; revision: number; graph: FlowGraph }

    expect(copy.name).toBe('原始画布 副本')
    expect(copy.revision).toBe(0)
    expect(copy.graph.nodes).toHaveLength(2)
    expect(await prisma.flowOperation.count({ where: { flowId: copy.id } })).toBe(0)
  })
})

describe('GET /api/flows/:id/operations', () => {
  it('按 seq 升序分页，支持 sinceSeq', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    await commit(alice, flowId, {
      baseRevision: 0,
      transactions: [transaction('tx-1'), transaction('tx-2'), transaction('tx-3')],
      graph: graphWith(1),
    })

    const all = await alice.request(`/api/flows/${flowId}/operations`)
    const body = (await all.json()) as {
      items: { seq: number; ops: unknown[]; clientTs: number; serverTs: number }[]
      total: number
    }
    expect(body.total).toBe(3)
    expect(body.items.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(body.items[0]!.ops).toHaveLength(1)

    const since = await alice.request(`/api/flows/${flowId}/operations?sinceSeq=2`)
    await expect(since.json()).resolves.toMatchObject({ total: 1 })
  })
})
