import { Flow, FlowDocStore } from '@learning/canvas'
import { nodesMap } from '@learning/contracts/flow-doc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { roomOf } from '../src/flow-persistence.js'
import { addNodes, createFlow, createProject, describeOnBothDatabases, docWith, nodeIdsOf, nodeMap } from './helpers.js'

/** 从 `apps/server/test/collab/persistence.test.ts` 移植，只换了注入方式（`EntityManager` 的 spy 换成 `FlowDocStore` 的 spy：这个包不碰 ORM） */
describeOnBothDatabases('落库', (ctx) => {
  const persistence = () => ctx.persistence
  const store = () => ctx.app.get(FlowDocStore, { strict: false })
  const newFlow = async () => {
    const alice = await ctx.actor()
    return createFlow(alice, await createProject(alice))
  }
  const row = (flowId: string) => ctx.dataAccess.em().findOneOrFail(Flow, { id: flowId }, { populate: ['ydoc', 'graph'] })
  const savedNodes = async (flowId: string) => {
    const { ydoc } = await row(flowId)
    return nodeIdsOf(ydoc)
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ctx.persistence.onStoreStateChange(null)
  })

  describe('写放大', () => {
    it('平时只写 ydoc，派生投影原封不动', async () => {
      const flowId = await newFlow()
      await persistence().store(roomOf(flowId), docWith(['n1', 'n2']))
      await persistence().drain()

      const after = await row(flowId)
      expect(after.ydoc).not.toBeNull()
      // 内容进了 ydoc，但列表页看到的还是初始值：投影要等散场
      expect(after.nodeCount).toBe(0)
      expect(JSON.parse(after.graph).nodes).toHaveLength(0)
      await persistence().forget(roomOf(flowId))
    })

    it('落库推进 updatedAt —— CAS 写走的是 nativeUpdate，不会自动带上它', async () => {
      const flowId = await newFlow()
      const past = new Date(Date.now() - 60_000)
      await ctx.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { updatedAt: past })

      await persistence().store(roomOf(flowId), docWith(['n1']))

      expect((await row(flowId)).updatedAt.getTime()).toBeGreaterThan(past.getTime())
      await persistence().forget(roomOf(flowId))
    })

    it('散场时才把投影补上', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1', 'n2'])

      await persistence().store(roomOf(flowId), doc)
      await persistence().store(roomOf(flowId), doc, { projection: true })

      const after = await row(flowId)
      expect(after.nodeCount).toBe(2)
      expect(JSON.parse(after.graph).nodes).toHaveLength(2)
      await persistence().forget(roomOf(flowId))
    })

    it('文档没变就整个跳过，不产生第二次写', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])

      await persistence().store(roomOf(flowId), doc)
      const first = await row(flowId)
      await persistence().store(roomOf(flowId), doc)

      expect((await row(flowId)).revision).toBe(first.revision)
      await persistence().forget(roomOf(flowId))
    })

    it('内容真的变了就照写不误', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])

      await persistence().store(roomOf(flowId), doc)
      const first = await row(flowId)
      nodesMap(doc).set('n2', nodeMap())
      await persistence().store(roomOf(flowId), doc)

      expect((await row(flowId)).revision).toBeGreaterThan(first.revision)
      await persistence().forget(roomOf(flowId))
    })

    it('要投影时不走「没变就跳过」那条捷径 —— 否则复制画布会拿到旧投影', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])

      await persistence().store(roomOf(flowId), doc)
      expect((await row(flowId)).nodeCount).toBe(0)

      await persistence().store(roomOf(flowId), doc, { projection: true })
      expect((await row(flowId)).nodeCount).toBe(1)
      await persistence().forget(roomOf(flowId))
    })

    it('散场清掉状态向量后，下一轮会重新写一次', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])

      await persistence().store(roomOf(flowId), doc)
      const first = await row(flowId)
      await persistence().forget(roomOf(flowId))

      await persistence().store(roomOf(flowId), doc)
      expect((await row(flowId)).revision).toBeGreaterThan(first.revision)
      await persistence().forget(roomOf(flowId))
    })
  })

  describe('落库失败：要抛、要记账、恢复之后要真的补上', () => {
    it('写库失败 → 往外抛，不能报成成功', async () => {
      const flowId = await newFlow()
      vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))

      // 抛出去 Hocuspocus 才会保住文档：吞掉的话两道保护都不会触发
      await expect(persistence().store(roomOf(flowId), docWith(['n1']))).rejects.toThrow('数据库炸了')
    })

    it('失败会记账，好让重试认得出来', async () => {
      const flowId = await newFlow()
      vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))

      await expect(persistence().store(roomOf(flowId), docWith(['n1']))).rejects.toThrow()
      expect(persistence().failedStoreCount()).toBe(1)
    })

    it('数据库恢复后，重试把内容真的写进去，欠账归零', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1', 'n2'])

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))
      await expect(persistence().store(roomOf(flowId), doc)).rejects.toThrow()
      expect(persistence().failedStoreCount()).toBe(1)
      // 这会儿库里还是空的：内容只在内存
      expect((await row(flowId)).nodeCount).toBe(0)

      write.mockRestore()
      await persistence().retryFailed()

      expect(persistence().failedStoreCount()).toBe(0)
      const saved = await row(flowId)
      expect(saved.nodeCount).toBe(2)
      expect(saved.ydoc).not.toBeNull()
      await persistence().forget(roomOf(flowId))
    })

    it('一次失败不会把这张画布的队列堵死，后面的写照常', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValueOnce(new Error('抖了一下'))
      await expect(persistence().store(roomOf(flowId), doc)).rejects.toThrow()

      write.mockRestore()
      doc.transact(() => nodesMap(doc).delete('n1'))
      await persistence().store(roomOf(flowId), doc)

      expect(persistence().failedStoreCount()).toBe(0)
      await persistence().forget(roomOf(flowId))
    })

    it('状态向量没记住不算落库失败：那是共享层缓存，真正的写入已经成功了', async () => {
      const flowId = await newFlow()
      const versions = (persistence() as unknown as { storedVersions: { set(): Promise<void>; get(): Promise<undefined> } }).storedVersions
      vi.spyOn(versions, 'set').mockRejectedValue(new Error('共享层挂了'))
      vi.spyOn(versions, 'get').mockRejectedValue(new Error('共享层挂了'))

      await expect(persistence().store(roomOf(flowId), docWith(['n1']))).resolves.toBeUndefined()
      expect(persistence().failedStoreCount()).toBe(0)
      expect((await row(flowId)).ydoc).not.toBeNull()
    })

    it('统计在写库处数：写成功算 completed，失败算 failed，「没变就跳过」两边都不算', async () => {
      const flowId = await newFlow()
      const doc = docWith(['n1'])
      const before = persistence().storeStats()

      await persistence().store(roomOf(flowId), doc)
      await persistence().store(roomOf(flowId), doc) // 跳过
      expect(persistence().storeStats().completed).toBe(before.completed + 1)
      expect(persistence().storeStats().failed).toBe(before.failed)
      expect(persistence().storeStats().lastOkAt).not.toBeNull()

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('炸了'))
      nodesMap(doc).set('n2', nodeMap())
      await expect(persistence().store(roomOf(flowId), doc)).rejects.toThrow()
      expect(persistence().storeStats().failed).toBe(before.failed + 1)
      write.mockRestore()
      await persistence().retryFailed()
    })
  })

  describe('跨副本的落库并发：读 → 合并 → CAS', () => {
    it('两个副本各带一部分改动 → 库里是合并，不是后写的那份', async () => {
      const flowId = await newFlow()
      const room = roomOf(flowId)

      await persistence().store(room, docWith(['n1']))
      expect(await savedNodes(flowId)).toEqual(['n1'])

      // 副本 B 完全不知道 A 的存在（pub/sub 断了就是这个样子）
      await persistence().store(room, docWith(['n2']))

      // 覆盖写的话这里只剩 n2
      expect(await savedNodes(flowId)).toEqual(['n1', 'n2'])
      await persistence().forget(room)
    })

    it('合并是双向的：落一次库，本副本的内存文档也补上了对方的内容', async () => {
      const flowId = await newFlow()
      const room = roomOf(flowId)

      await persistence().store(room, docWith(['n1']))
      const b = docWith(['n2'])
      await persistence().store(room, b)

      expect([...nodesMap(b).keys()].sort()).toEqual(['n1', 'n2'])
      await persistence().forget(room)
    })

    /** 读之后、写之前从旁边写一次库，就像另一个实例干的。只有 where 里带 revision 才挡得住：盖上去的话旁边那个节点就没了 */
    it('读完之后被别的实例抢先 → CAS 没命中，重读重来，两边的内容都在', async () => {
      const flowId = await newFlow()
      const room = roomOf(flowId)
      const docs = store()
      const realRead = docs.read.bind(docs)
      let raced = false
      const read = vi.spyOn(docs, 'read').mockImplementation(async (id, options) => {
        const result = await realRead(id, options)
        if (!raced) {
          raced = true
          const peer = await realRead(id, { liveProject: false, legacy: false })
          await docs.compareAndWrite(id, peer?.revision ?? 0, { ydoc: addNodes('from-other-instance') })
        }
        return result
      })

      await persistence().store(room, docWith(['mine']))

      expect(read).toHaveBeenCalledTimes(2) // 第一次读完被抢先、CAS 扑空，第二次重读
      expect(await savedNodes(flowId)).toEqual(['from-other-instance', 'mine'])
      await persistence().forget(room)
    })

    it('CAS 撞车 → 重读重来，内容不丢', async () => {
      const flowId = await newFlow()
      const room = roomOf(flowId)
      const write = vi.spyOn(store(), 'compareAndWrite').mockResolvedValueOnce(false)

      await persistence().store(room, docWith(['n1']))

      expect(await savedNodes(flowId)).toEqual(['n1'])
      expect(write).toHaveBeenCalledTimes(2)
      await persistence().forget(room)
    })

    it('连续撞车 → 抛出去，交给欠账重试，内容留在内存', async () => {
      const flowId = await newFlow()
      vi.spyOn(store(), 'compareAndWrite').mockResolvedValue(false)

      await expect(persistence().store(roomOf(flowId), docWith(['n1']))).rejects.toThrow(/被抢先写入/)
      expect(persistence().failedStoreCount()).toBe(1)
    })

    it('revision 每次落库都往前走 —— CAS 的比较基准就是它', async () => {
      const flowId = await newFlow()
      const room = roomOf(flowId)
      const doc = docWith(['n1'])

      await persistence().store(room, doc)
      const first = (await row(flowId)).revision
      nodesMap(doc).set('n2', nodeMap())
      await persistence().store(room, doc)

      expect((await row(flowId)).revision).toBe(first + 1)
      await persistence().forget(room)
    })

    it('画布已被删 → 静静收工，不抛也不记欠账', async () => {
      const flowId = await newFlow()
      await ctx.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { deletedAt: new Date() })

      await expect(persistence().store(roomOf(flowId), docWith(['n1']))).resolves.toBeUndefined()
      expect(persistence().failedStoreCount()).toBe(0)
    })

    it('不是画布房间 → 不落库', async () => {
      await expect(persistence().store('demo', docWith(['n1']))).resolves.toBeUndefined()
      expect(await persistence().load('demo')).toBeNull()
    })
  })

  describe('落库状态通知：只在翻转时说', () => {
    function collect(): string[] {
      const seen: string[] = []
      persistence().onStoreStateChange((room, ok) => seen.push(`${room}:${ok}`))
      return seen
    }

    it('第一次失败通知一次，恢复之后再通知一次', async () => {
      const room = roomOf(await newFlow())
      const doc = docWith(['n1'])
      const seen = collect()

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('炸了'))
      await expect(persistence().store(room, doc)).rejects.toThrow()
      expect(seen).toEqual([`${room}:false`])

      write.mockRestore()
      await persistence().retryFailed()
      expect(seen).toEqual([`${room}:false`, `${room}:true`])
      await persistence().forget(room)
    })

    it('连续失败只通知一次，连续成功一次都不通知', async () => {
      const room = roomOf(await newFlow())
      const doc = docWith(['n1'])
      const seen = collect()

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('炸了'))
      await expect(persistence().store(room, doc)).rejects.toThrow()
      await expect(persistence().store(room, doc)).rejects.toThrow()
      await expect(persistence().store(room, doc)).rejects.toThrow()
      expect(seen).toEqual([`${room}:false`])

      write.mockRestore()
      await persistence().store(room, doc)
      const afterRecovery = [...seen]

      doc.transact(() => nodesMap(doc).delete('n1'))
      await persistence().store(room, doc)
      expect(seen).toEqual(afterRecovery)
      await persistence().forget(room)
    })

    it('通知回调抛异常不影响落库', async () => {
      const room = roomOf(await newFlow())
      const doc = docWith(['n1'])
      persistence().onStoreStateChange(() => {
        throw new Error('广播失败')
      })

      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValueOnce(new Error('炸了'))
      // 抛的仍是落库那个异常，不是广播那个
      await expect(persistence().store(room, doc)).rejects.toThrow('炸了')

      write.mockRestore()
      await expect(persistence().store(room, doc)).resolves.toBeUndefined()
      expect(persistence().failedStoreCount()).toBe(0)
      await persistence().forget(room)
    })

    it('isStoreFailing 报得出当前欠着的房间 —— 新连接靠它补发通知', async () => {
      const room = roomOf(await newFlow())
      const doc = docWith(['n1'])

      expect(persistence().isStoreFailing(room)).toBe(false)
      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('炸了'))
      await expect(persistence().store(room, doc)).rejects.toThrow()
      expect(persistence().isStoreFailing(room)).toBe(true)

      write.mockRestore()
      await persistence().retryFailed()
      expect(persistence().isStoreFailing(room)).toBe(false)
      await persistence().forget(room)
    })
  })

})

describe('Y.Doc 的合并 origin', () => {
  it('合并用 persistence origin：不是 local，不进撤销栈（UndoManager 只跟踪自己的 origin）', async () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(nodesMap(doc), { trackedOrigins: new Set(['local']) })
    Y.applyUpdate(doc, addNodes('from-db'), 'persistence')
    expect(undo.undoStack).toHaveLength(0)
    undo.destroy()
    doc.destroy()
  })
})
