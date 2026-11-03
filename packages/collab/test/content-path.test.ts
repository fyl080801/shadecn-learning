import { Flow } from '@learning/canvas'
import { applyGraphToDoc, nodesMap } from '@learning/contracts/flow-doc'
import { emptyGraph, type FlowGraph } from '@learning/contracts/flow-graph'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { roomOf } from '../src/flow-persistence.js'
import { createFlow, createProject, describeOnBothDatabases } from './helpers.js'

/**
 * 画布内容的写入路径。从 `apps/server/test/routes/flows.test.ts` 移植，走 direct connection（房间是真的，落库是真的钩子）。
 * 老 graph 迁移那条不移植：这个服务没有老数据（docs/30 §1）。
 */
function graphWith(nodeCount: number): FlowGraph {
  const graph = emptyGraph()
  for (let i = 0; i < nodeCount; i += 1) {
    graph.nodes.push({ id: `n${i}`, type: 'process', layout: { position: { x: i * 100, y: 0 } }, metadata: { label: `节点 ${i}` }, data: {}, runtime: { status: 'idle' } })
    if (i > 0) graph.edges.push({ id: `e${i}`, source: `n${i - 1}`, target: `n${i}`, data: {} })
  }
  return graph
}

describeOnBothDatabases('画布内容的写入路径（Yjs）', (ctx) => {
  const hocuspocus = () => ctx.server.hocuspocus

  async function closeRoom(flowId: string): Promise<void> {
    await vi.waitFor(() => expect(hocuspocus().documents.has(roomOf(flowId))).toBe(false), { timeout: 5000 })
  }

  /** 开房间写进去、散场 */
  async function writeGraph(flowId: string, graph: FlowGraph): Promise<void> {
    const connection = await hocuspocus().openDirectConnection(roomOf(flowId), {})
    await connection.transact((doc: Y.Doc) => applyGraphToDoc(doc, graph))
    await connection.disconnect()
    await closeRoom(flowId)
  }

  const newFlow = async () => {
    const alice = await ctx.actor()
    return { alice, flowId: await createFlow(alice, await createProject(alice)) }
  }

  it('房间散场后内容落库，派生的快照与统计一起更新', async () => {
    const { alice, flowId } = await newFlow()

    await writeGraph(flowId, graphWith(3))

    const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ revision: number; nodeCount: number; edgeCount: number; graph: FlowGraph }>()
    expect(detail.nodeCount).toBe(3)
    expect(detail.edgeCount).toBe(2)
    expect(detail.graph.nodes.map((node) => node.id)).toEqual(['n0', 'n1', 'n2'])
    expect(detail.revision).toBeGreaterThan(0)

    const row = await ctx.dataAccess.em().findOneOrFail(Flow, { id: flowId }, { populate: ['ydoc'] })
    expect(row.ydoc?.length).toBeGreaterThan(0)
  })

  it('重新打开时从 ydoc 恢复，内容不丢', async () => {
    const { flowId } = await newFlow()
    await writeGraph(flowId, graphWith(2))

    // 房间已经拆了；再开一次相当于服务端重启后有人重新访问
    const connection = await hocuspocus().openDirectConnection(roomOf(flowId), {})
    await connection.transact((doc: Y.Doc) => {
      expect([...doc.getMap('nodes').keys()].sort()).toEqual(['n0', 'n1'])
    })
    await connection.disconnect()
    await closeRoom(flowId)
  })

  it('节点 data 上平铺的任意业务字段原样存取', async () => {
    const { alice, flowId } = await newFlow()
    const business = { 嵌套: { 数组: [1, '二', null], 布尔: true }, 空对象: {}, prompt: '一只猫' }
    const graph = graphWith(1)
    Object.assign(graph.nodes[0].data, business)

    await writeGraph(flowId, graph)

    const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ graph: FlowGraph }>()
    expect(detail.graph.nodes[0].data).toMatchObject(business)
  })

  it('两个客户端并发改同一个节点的不同字段，两边的改动都留下', async () => {
    const { alice, flowId } = await newFlow()
    await writeGraph(flowId, graphWith(1))

    const connection = await hocuspocus().openDirectConnection(roomOf(flowId), {})
    const right = new Y.Doc()
    const groupOf = (doc: Y.Doc, group: string) => nodesMap(doc).get('n0')?.get(group) as Y.Map<unknown>
    // 各自从同一份状态出发，离线改不同字段，再互相合并
    await connection.transact((left: Y.Doc) => {
      Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
      groupOf(left, 'metadata').set('label', '甲改的标题')
    })
    groupOf(right, 'data').set('prompt', '乙写的提示词')
    await connection.transact((left: Y.Doc) => Y.applyUpdate(left, Y.encodeStateAsUpdate(right)))
    await connection.disconnect()
    await closeRoom(flowId)
    right.destroy()

    const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ graph: FlowGraph }>()
    expect(detail.graph.nodes[0].metadata.label).toBe('甲改的标题')
    expect(detail.graph.nodes[0].data.prompt).toBe('乙写的提示词')
  })
})
