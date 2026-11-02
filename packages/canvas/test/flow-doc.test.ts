import { Cluster } from '@learning/cluster'
import type { FlowGraph } from '@learning/contracts/flow-graph'
import { describe, expect, it, vi } from 'vitest'
import { Flow } from '../src/entities.js'
import { CANVAS_FLUSH_CONTENT, FlowDocStore } from '../src/flow-doc.store.js'
import { GRAPH_LIMITS } from '../src/flow-types.js'
import { createFlow, createProject, describeOnBothDatabases } from './helpers.js'
import { graphWith } from './graph-with.js'

describeOnBothDatabases('画布内容的存取', (ctx) => {
  const store = () => ctx.app.get(FlowDocStore)
  const CONTENT = new Uint8Array([1, 2, 3, 250])

  async function newFlow() {
    const alice = await ctx.actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId, '原始画布')
    return { alice, projectId, flowId }
  }

  describe('read', () => {
    it('还没写过：ydoc 是 null，legacy 给库里那份 graph，不要就不给', async () => {
      const { flowId } = await newFlow()

      const withGraph = await store().read(flowId, { liveProject: true, legacy: true })
      expect(withGraph).toMatchObject({ ydoc: null, revision: 0 })
      expect(withGraph?.legacy?.nodes).toEqual([])

      expect(await store().read(flowId, { liveProject: true, legacy: false })).toEqual({ ydoc: null, revision: 0, legacy: null })
    })

    it('写过之后：ydoc 是 Uint8Array，legacy 不再给', async () => {
      const { flowId } = await newFlow()
      await store().compareAndWrite(flowId, 0, { ydoc: CONTENT })

      const row = await store().read(flowId, { liveProject: true, legacy: true })
      expect(row?.ydoc).toBeInstanceOf(Uint8Array)
      expect([...(row?.ydoc ?? [])]).toEqual([...CONTENT])
      expect(row).toMatchObject({ revision: 1, legacy: null })
    })

    it('liveProject：项目删了之后进房读不到，落库读得到；画布本身删了都读不到', async () => {
      const { alice, projectId, flowId } = await newFlow()

      await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })
      expect(await store().read(flowId, { liveProject: true, legacy: false })).toBeNull()
      expect(await store().read(flowId, { liveProject: false, legacy: false })).not.toBeNull()

      await ctx.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { deletedAt: new Date() })
      expect(await store().read(flowId, { liveProject: false, legacy: false })).toBeNull()
    })

    it('不存在的画布 → null', async () => {
      expect(await store().read('none', { liveProject: false, legacy: false })).toBeNull()
    })
  })

  describe('compareAndWrite（revision）', () => {
    it('revision 对得上才写，写完 +1，updatedAt 前进；对不上不写', async () => {
      const { flowId } = await newFlow()
      const before = await ctx.dataAccess.em().findOneOrFail(Flow, flowId)
      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(await store().compareAndWrite(flowId, 0, { ydoc: CONTENT })).toBe(true)
      const after = await ctx.dataAccess.em().findOneOrFail(Flow, flowId)
      expect(after.revision).toBe(1)
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())

      expect(await store().compareAndWrite(flowId, 0, { ydoc: new Uint8Array([9]) })).toBe(false)
      const row = await store().read(flowId, { liveProject: false, legacy: false })
      expect([...(row?.ydoc ?? [])]).toEqual([...CONTENT])
      expect(row?.revision).toBe(1)
    })

    it('并发写同一个 revision：只有一个赢，内容是赢家的', async () => {
      const { flowId } = await newFlow()
      const writes = [1, 2, 3, 4, 5].map((value) => new Uint8Array([value]))

      const results = await Promise.all(writes.map((ydoc) => store().compareAndWrite(flowId, 0, { ydoc })))

      expect(results.filter(Boolean)).toHaveLength(1)
      const row = await store().read(flowId, { liveProject: false, legacy: false })
      expect(row?.revision).toBe(1)
      expect([...(row?.ydoc ?? [])]).toEqual([...(writes[results.indexOf(true)] as Uint8Array)])
    })

    it('已删的画布写不进去', async () => {
      const { flowId } = await newFlow()
      await ctx.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { deletedAt: new Date() })
      expect(await store().compareAndWrite(flowId, 0, { ydoc: CONTENT })).toBe(false)
    })

    it('投影和计数一起写，详情读到的就是它；不给投影就不动', async () => {
      const { alice, flowId } = await newFlow()
      await store().compareAndWrite(flowId, 0, { ydoc: CONTENT, projection: graphWith(3) })

      const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ revision: number; nodeCount: number; edgeCount: number; graph: FlowGraph }>()
      expect(detail).toMatchObject({ revision: 1, nodeCount: 3, edgeCount: 2 })
      expect(detail.graph.nodes.map((node) => node.id)).toEqual(['n0', 'n1', 'n2'])

      await store().compareAndWrite(flowId, 1, { ydoc: CONTENT })
      expect((await alice.request(`/api/flows/${flowId}`)).json()).toMatchObject({ revision: 2, nodeCount: 3 })
    })

    it('投影超过字节上限：跳过投影，内容照写', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { alice, flowId } = await newFlow()
      const huge = graphWith(1)
      Object.assign(huge.nodes[0]?.data as object, { blob: 'x'.repeat(GRAPH_LIMITS.bytes) })

      expect(await store().compareAndWrite(flowId, 0, { ydoc: CONTENT, projection: huge })).toBe(true)

      const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ graph: FlowGraph }>()
      expect(detail).toMatchObject({ revision: 1, nodeCount: 0 })
      expect(detail.graph.nodes).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  })

  describe('POST /api/flows/:id/duplicate', () => {
    it('复制内容，新画布 revision 从 0 起，状态和标签跟着走，缩略图不跟', async () => {
      const { alice, projectId, flowId } = await newFlow()
      await store().compareAndWrite(flowId, 0, { ydoc: CONTENT, projection: graphWith(2) })
      await alice.json(`/api/flows/${flowId}`, 'PATCH', { status: 'published', tags: ['t'] })
      await ctx.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { thumbnail: 'http://x/thumb.png' })

      const res = await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')
      expect(res.status).toBe(201)
      const copy = res.json<{ id: string; graph: FlowGraph }>()

      expect(copy).toMatchObject({ projectId, name: '原始画布 副本', revision: 0, status: 'published', tags: ['t'], thumbnail: null, nodeCount: 2, edgeCount: 1, createdById: alice.userId, userState: {} })
      expect(copy.graph.nodes).toHaveLength(2)
      const row = await store().read(copy.id, { liveProject: true, legacy: false })
      expect([...(row?.ydoc ?? [])]).toEqual([...CONTENT])
    })

    it('先落库再复制：持有活内容的实例写进库的那份会出现在副本里', async () => {
      const { alice, flowId } = await newFlow()
      const bus = ctx.app.get(Cluster).bus
      const seen: string[] = []
      const off = await bus.handle(CANVAS_FLUSH_CONTENT, async ({ flowId: id }) => {
        seen.push(id)
        await store().compareAndWrite(id, 0, { ydoc: CONTENT, projection: graphWith(1) })
        return null
      })
      try {
        const copy = (await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')).json<{ id: string; nodeCount: number }>()
        expect(seen).toEqual([flowId])
        expect(copy.nodeCount).toBe(1)
        const row = await store().read(copy.id, { liveProject: true, legacy: false })
        expect([...(row?.ydoc ?? [])]).toEqual([...CONTENT])
      } finally {
        await off()
      }
    })

    it('没有协同回话不抛错：退到读库', async () => {
      const { alice, flowId } = await newFlow()
      const res = await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')
      expect(res.status).toBe(201)
    })

    it('落库处理函数失败也不挡复制，只记一笔', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { alice, flowId } = await newFlow()
      const off = await ctx.app.get(Cluster).bus.handle(CANVAS_FLUSH_CONTENT, () => {
        throw new Error('落库失败')
      })
      try {
        expect((await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')).status).toBe(201)
        expect(warn.mock.calls.flat().join(' ')).toContain('落库失败')
      } finally {
        await off()
        warn.mockRestore()
        error.mockRestore()
      }
    })
  })
})

describe('@learning/canvas 的导出', () => {
  it('落库令牌的名字就是 docs/30 §2 写的那个', () => {
    expect(CANVAS_FLUSH_CONTENT.name).toBe('canvas.flush-content')
  })
})
