import { Flow, FlowDocStore } from '@learning/canvas'
import { edgesMap, nodesMap } from '@learning/contracts/flow-doc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { FlowPersistence, roomOf } from '../src/flow-persistence.js'
import { FlowWriter } from '../src/flow-writer.js'
import { COLLAB_LIMITS } from '../src/quota.js'
import { addNodes, createFlow, createProject, describeOnBothDatabases, nodeIdsOf } from './helpers.js'

/**
 * 个人画布的写入通道。从 `apps/server/test/collab/flow-writer.test.ts` 移植。
 * 这条路没有房间，一次 HTTP 就是一次「读库 → 合并 → 写回」：重发要幂等、两个标签页的改动都得在、超限的整段要拒掉。
 */
describeOnBothDatabases('个人画布的写入通道', (ctx) => {
  const writer = () => ctx.app.get(FlowWriter, { strict: false })
  const store = () => ctx.app.get(FlowDocStore, { strict: false })
  const persistence = () => ctx.app.get(FlowPersistence, { strict: false })
  const em = () => ctx.dataAccess.em()
  const newFlow = async () => {
    const alice = await ctx.actor()
    return createFlow(alice, await createProject(alice))
  }
  const nodeIds = async (flowId: string) => nodeIdsOf((await em().findOneOrFail(Flow, { id: flowId }, { populate: ['ydoc'] })).ydoc)

  afterEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('推一段增量 → 内容落库、投影跟着更新', async () => {
    const flowId = await newFlow()

    const result = await writer().apply(flowId, addNodes('n1', 'n2'))

    expect(result.ok).toBe(true)
    expect(await nodeIds(flowId)).toEqual(['n1', 'n2'])
    const row = await em().findOneOrFail(Flow, { id: flowId }, { populate: ['graph'] })
    // 协同那边投影要等散场，这边每次都写：列表页的计数不能等人离开画布
    expect(row.nodeCount).toBe(2)
    expect(JSON.parse(row.graph).nodes).toHaveLength(2)
    expect(row.revision).toBe(1)
    await persistence().forget(roomOf(flowId))
  })

  it('写入推进 updatedAt —— CAS 写走的是 nativeUpdate，不会自动带上它', async () => {
    const flowId = await newFlow()
    const past = new Date(Date.now() - 60_000)
    await em().nativeUpdate(Flow, { id: flowId }, { updatedAt: past })

    expect((await writer().apply(flowId, addNodes('n1'))).ok).toBe(true)

    expect((await em().findOneOrFail(Flow, { id: flowId })).updatedAt.getTime()).toBeGreaterThan(past.getTime())
    await persistence().forget(roomOf(flowId))
  })

  it('同一段增量推两次 → 第二次是 noop，不写库', async () => {
    const flowId = await newFlow()
    const update = addNodes('n1')

    await writer().apply(flowId, update)
    const again = await writer().apply(flowId, update)

    expect(again.ok && again.noop).toBe(true)
    expect(await nodeIds(flowId)).toEqual(['n1'])
    expect((await em().findOneOrFail(Flow, { id: flowId })).revision).toBe(1)
    await persistence().forget(roomOf(flowId))
  })

  it('两个标签页各推各的 → 改动都在，谁也没被抹掉', async () => {
    const flowId = await newFlow()

    await Promise.all([writer().apply(flowId, addNodes('from-tab-a')), writer().apply(flowId, addNodes('from-tab-b'))])

    expect(await nodeIds(flowId)).toEqual(['from-tab-a', 'from-tab-b'])
    await persistence().forget(roomOf(flowId))
  })

  it('增量基于服务端返回的状态向量算 → 只发差量也能合并对', async () => {
    const flowId = await newFlow()
    const first = await writer().apply(flowId, addNodes('n1'))
    if (!first.ok) throw new Error('第一次推送就失败了')

    const local = new Y.Doc()
    Y.applyUpdate(local, (await writer().read(flowId))?.update ?? new Uint8Array())
    const node = new Y.Map<unknown>()
    node.set('position', { x: 1, y: 1 })
    nodesMap(local).set('n2', node)
    const diff = Y.encodeStateAsUpdate(local, first.stateVector)
    local.destroy()

    await writer().apply(flowId, diff)

    expect(await nodeIds(flowId)).toEqual(['n1', 'n2'])
    await persistence().forget(roomOf(flowId))
  })

  it('端点已经不在的连线被清掉', async () => {
    const flowId = await newFlow()
    await writer().apply(flowId, addNodes('n1'))

    const doc = new Y.Doc()
    doc.transact(() => {
      const edge = new Y.Map<unknown>()
      edge.set('source', 'n1')
      edge.set('target', 'ghost')
      edgesMap(doc).set('e1', edge)
    })
    await writer().apply(flowId, Y.encodeStateAsUpdate(doc))
    doc.destroy()

    const stored = new Y.Doc()
    Y.applyUpdate(stored, new Uint8Array((await em().findOneOrFail(Flow, { id: flowId }, { populate: ['ydoc'] })).ydoc ?? []))
    expect(edgesMap(stored).size).toBe(0)
    stored.destroy()
    await persistence().forget(roomOf(flowId))
  })

  it('合并之后超过体积上限 → 整段拒掉，库里一个节点都没多', async () => {
    const flowId = await newFlow()
    await writer().apply(flowId, addNodes('keep'))

    // 单次推送另有 message 那道关，一发请求撑不爆文档：直接把库里那份做大，测的是合并之后的判定
    const fat = new Y.Doc()
    const node = new Y.Map<unknown>()
    const data = new Y.Map<unknown>()
    data.set('label', 'x'.repeat(COLLAB_LIMITS.document + 1))
    node.set('data', data)
    nodesMap(fat).set('big', node)
    await em().nativeUpdate(Flow, { id: flowId }, { ydoc: Buffer.from(Y.encodeStateAsUpdate(fat)) })
    fat.destroy()

    const result = await writer().apply(flowId, addNodes('n1'))

    expect(result.ok === false && result.reason).toBe('too-large')
    expect(await nodeIds(flowId)).toEqual(['big'])
    await persistence().forget(roomOf(flowId))
  })

  it('单条消息超过字节上限 → 连读库都不用', async () => {
    const flowId = await newFlow()
    const read = vi.spyOn(store(), 'read')

    const result = await writer().apply(flowId, new Uint8Array(COLLAB_LIMITS.message + 1))

    expect(result.ok === false && result.reason).toBe('too-large')
    expect(read).not.toHaveBeenCalled()
  })

  it('画布不存在 / 已软删 → not-found', async () => {
    const flowId = await newFlow()
    await em().nativeUpdate(Flow, { id: flowId }, { deletedAt: new Date() })

    const deleted = await writer().apply(flowId, addNodes('n1'))
    expect(deleted.ok === false && deleted.reason).toBe('not-found')

    const missing = await writer().apply('no-such-flow', addNodes('n1'))
    expect(missing.ok === false && missing.reason).toBe('not-found')
  })

  it('读回来的差量只带没见过的部分', async () => {
    const flowId = await newFlow()
    const first = await writer().apply(flowId, addNodes('n1'))
    if (!first.ok) throw new Error('第一次推送就失败了')

    const full = await writer().read(flowId)
    const diff = await writer().read(flowId, first.stateVector)
    if (!full || !diff) throw new Error('读不到画布状态')
    expect(diff.update.byteLength).toBeLessThan(full.update.byteLength)
    // 状态向量给的是服务端自己的进度：客户端拿它当基线，离线时攒的改动才推得出去
    expect(full.stateVector).toEqual(first.stateVector)
    expect(await writer().read('no-such-flow')).toBeNull()
    await persistence().forget(roomOf(flowId))
  })

  describe('写回撞车时的重试：单进程内撞不上这一支（写队列排开了），人为制造读和写之间的那个瞬间', () => {
    /** 每次读完之后，从旁边写一次（不走队列，就像另一个实例干的） */
    function raceOnRead(update: Uint8Array, times: number) {
      const docs = store()
      const real = docs.read.bind(docs)
      let done = 0
      let racing = false
      return vi.spyOn(docs, 'read').mockImplementation(async (id, options) => {
        const row = await real(id, options)
        if (racing || done >= times) return row
        done += 1
        racing = true
        const fresh = await real(id, { liveProject: false, legacy: false })
        const doc = new Y.Doc()
        if (fresh?.ydoc) Y.applyUpdate(doc, fresh.ydoc)
        Y.applyUpdate(doc, update)
        await docs.compareAndWrite(id, fresh?.revision ?? 0, { ydoc: Y.encodeStateAsUpdate(doc) })
        doc.destroy()
        racing = false
        return row
      })
    }

    it('被抢先一次 → 重读重来，两边的改动都在', async () => {
      const flowId = await newFlow()
      await writer().apply(flowId, addNodes('base'))

      raceOnRead(addNodes('from-other-instance'), 1)
      const result = await writer().apply(flowId, addNodes('mine'))

      expect(result.ok && result.noop).toBe(false)
      expect(await nodeIds(flowId)).toEqual(['base', 'from-other-instance', 'mine'].sort())
      const { revision } = await em().findOneOrFail(Flow, { id: flowId })
      // base=1、别的实例=2、我的=3；返回值要和库里对得上
      expect(revision).toBe(3)
      expect(result.ok && result.revision).toBe(3)
      await persistence().forget(roomOf(flowId))
    })

    it('一直被抢先 → 抛错，而不是假装写成功', async () => {
      const flowId = await newFlow()
      await writer().apply(flowId, addNodes('base'))

      raceOnRead(addNodes('always-losing'), Number.POSITIVE_INFINITY)

      // 返回 ok 的话客户端把基线往前推，那段内容就再也补不回来了，而界面一直显示「已保存」
      await expect(writer().apply(flowId, addNodes('mine'))).rejects.toThrow(/抢先写入/)
      expect(await nodeIds(flowId)).not.toContain('mine')
      await persistence().forget(roomOf(flowId))
    })
  })
})
