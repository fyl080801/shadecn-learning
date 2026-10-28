import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { nodesMap } from '../../collab/flow-doc.ts'
import {
  failedStoreCount,
  flushCollabWrites,
  forgetFlow,
  isStoreFailing,
  onStoreStateChange,
  retryFailedStores,
  roomOf,
  storeFlowState,
} from '../../collab/persistence.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * 落库的写放大。两处省法都要能验证：
 * - 状态向量没变 → 整个跳过；
 * - 平时只写 ydoc，派生投影留到散场。
 */

async function newFlow() {
  const alice = await actor()
  const projectId = await createProject(alice)
  return createFlow(alice, projectId)
}

function docWith(nodeIds: string[]) {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of nodeIds) {
      const node = new Y.Map<unknown>()
      node.set('position', { x: 0, y: 0 })
      const data = new Y.Map<unknown>()
      data.set('label', id)
      node.set('data', data)
      nodesMap(doc).set(id, node)
    }
  })
  return doc
}

/** 库里那行现在长什么样 */
async function row(flowId: string) {
  return prisma.flow.findUniqueOrThrow({
    where: { id: flowId },
    select: { ydoc: true, graph: true, nodeCount: true, revision: true },
  })
}

describe('落库的写放大', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('平时只写 ydoc，派生投影原封不动', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.ydoc).not.toBeNull()
    // 内容进了 ydoc，但列表页看到的还是初始值 —— 投影要等散场
    expect(after.nodeCount).toBe(0)
    expect(JSON.parse(after.graph).nodes).toHaveLength(0)
    await forgetFlow(roomOf(flowId))
  })

  it('散场时才把投影补上', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2'])

    await storeFlowState(roomOf(flowId), doc)
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.nodeCount).toBe(2)
    expect(JSON.parse(after.graph).nodes).toHaveLength(2)
    await forgetFlow(roomOf(flowId))
  })

  it('文档没变就整个跳过，不产生第二次写', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    // 一个字都没改，再存一次
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const second = await row(flowId)

    expect(second.revision).toBe(first.revision)
    await forgetFlow(roomOf(flowId))
  })

  it('内容真的变了就照写不误', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    const node = new Y.Map<unknown>()
    node.set('position', { x: 1, y: 1 })
    nodesMap(doc).set('n2', node)

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const second = await row(flowId)

    expect(second.revision).toBeGreaterThan(first.revision)
    await forgetFlow(roomOf(flowId))
  })

  it('要投影时不走「没变就跳过」那条捷径 —— 否则复制画布会拿到旧投影', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    // 先写一次（只有 ydoc），此时状态向量已经记下了
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(0)

    // 内容一个字没改，但这次要投影 —— 必须真的写
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(1)
    await forgetFlow(roomOf(flowId))
  })

  it('「改完等过防抖窗口再关页面」这条路径，投影也必须补上', async () => {
    // 这是 beforeUnloadDocument 存在的理由：Hocuspocus 在最后一个人离开时，
    // 只有还挂着防抖 store 才会补一次 onStoreDocument，否则直接卸载文档。
    // 所以「平时写 ydoc + 散场写投影」的散场那一半，不能只靠 onStoreDocument。
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2', 'n3'])

    // 模拟防抖窗口内的若干次写（都不带投影）
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(0)

    // 卸载前那一下（beforeUnloadDocument 走的就是这个调用）
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.nodeCount).toBe(3)
    expect(JSON.parse(after.graph).nodes).toHaveLength(3)
    await forgetFlow(roomOf(flowId))
  })

  it('散场清掉状态向量后，下一轮会重新写一次', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    await forgetFlow(roomOf(flowId))

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).revision).toBeGreaterThan(first.revision)
    await forgetFlow(roomOf(flowId))
  })
})


/**
 * 落库失败时的行为 —— docs/19 §4.1。
 *
 * 这里曾经是整个协同链路最贵的一个 bug：写队列把异常吞成一句 `console.error`，
 * 于是 `storeFlowState` 永远「成功」，Hocuspocus 认为存好了就把文档卸载出内存，
 * 而它自带的 *"Document stays in memory to avoid data loss"* 保护
 * **恰恰是靠 hook 抛异常触发的** —— 我们把那道保护自己关掉了。
 *
 * 所以这一组用例钉的是三件事：失败要抛、要记账、恢复之后要真的补上。
 */
describe('落库失败', () => {
  beforeEach(async () => {
    await resetDb()
    // 欠账表是模块级的，后端测试又共用一个进程（fileParallelism: false）
    await retryFailedStores()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('写库失败 → 往外抛，不能报成成功', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])
    vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('数据库炸了'))

    /*
     * 抛出去，Hocuspocus 才会保住文档：`onStoreDocument` 抛 → `storeDocumentHooks`
     * 的 catch 保留文档在内存；`beforeUnloadDocument` 抛 → `unloadDocument` 直接
     * return，既不 delete 也不 destroy。吞掉的话这两道都不会触发。
     */
    await expect(storeFlowState(roomOf(flowId), doc)).rejects.toThrow('数据库炸了')
  })

  it('失败会记账，好让重试认得出来', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])
    vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('数据库炸了'))

    await expect(storeFlowState(roomOf(flowId), doc)).rejects.toThrow()
    expect(failedStoreCount()).toBe(1)

    await forgetFlow(roomOf(flowId))
  })

  /**
   * 光「留在内存」还不够：`onStoreDocument` 由防抖触发，而这时房间里往往
   * 已经没人编辑了，没有任何东西会再叫它一次。不重试的话内容就一直悬着，
   * 直到进程退出 —— 要是那次退出是 SIGKILL，就全没了。
   */
  it('数据库恢复后，重试把内容真的写进去，欠账归零', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2'])

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('数据库炸了'))
    await expect(storeFlowState(roomOf(flowId), doc)).rejects.toThrow()
    expect(failedStoreCount()).toBe(1)
    // 这会儿库里还是空的 —— 内容只在内存
    expect((await row(flowId)).nodeCount).toBe(0)

    write.mockRestore()
    await retryFailedStores()
    await flushCollabWrites()

    expect(failedStoreCount()).toBe(0)
    const saved = await row(flowId)
    expect(saved.nodeCount).toBe(2)
    expect(saved.ydoc).not.toBeNull()

    await forgetFlow(roomOf(flowId))
  })

  it('一次失败不会把这张画布的队列堵死，后面的写照常', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValueOnce(new Error('抖了一下'))
    await expect(storeFlowState(roomOf(flowId), doc)).rejects.toThrow()

    // 队列是 `previous.then(task, task)`：前一个失败，后一个照样跑
    write.mockRestore()
    doc.transact(() => nodesMap(doc).delete('n1'))
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()

    expect(failedStoreCount()).toBe(0)
    await forgetFlow(roomOf(flowId))
  })

  /**
   * 状态向量写的是**共享层缓存**，不是画布内容。它失败时那次真正的写入已经成功了，
   * 抛出去会让调用方误判成落库失败、于是重试、于是又写一遍同样的字节。
   */
  it('状态向量没记住不算落库失败', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    const cluster = await import('../../cluster/index.ts')
    const restore = cluster.useBackendForTesting({
      ...cluster.createMemoryBackend(),
      createMap: () => {
        throw new Error('共享层挂了')
      },
    })

    try {
      await expect(storeFlowState(roomOf(flowId), doc)).resolves.toBeUndefined()
      await flushCollabWrites()
      expect(failedStoreCount()).toBe(0)
      expect((await row(flowId)).ydoc).not.toBeNull()
    } finally {
      restore()
      await forgetFlow(roomOf(flowId))
    }
  })
})


/**
 * 跨副本的落库并发 —— docs/19 §4.3。
 *
 * 协同落库原来是**全量覆盖写**：把内存里那份整个盖进 `ydoc`。单副本没问题
 * （这个进程是唯一的写者），多副本下 Redis pub/sub 断一下两个实例就此分叉，
 * 各自盖各自的，后写的赢。现在是读 → 合并 → CAS 写回。
 */
describe('落库的跨副本并发', () => {
  beforeEach(async () => {
    await resetDb()
    // 欠账表是模块级的，用例之间会串（后端测试共用一个进程）。
    // 库已经清空了，所以这一轮重试只会把欠账一笔笔销掉
    await retryFailedStores()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 把库里那份 ydoc 解出来看 */
  async function savedNodes(flowId: string): Promise<string[]> {
    const { ydoc } = await row(flowId)
    if (!ydoc) return []
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(ydoc))
    const keys = [...nodesMap(doc).keys()].sort()
    doc.destroy()
    return keys
  }

  it('两个副本各带一部分改动 → 库里是合并，不是后写的那份', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)

    // 副本 A 落库
    const a = docWith(['n1'])
    await storeFlowState(room, a)
    await flushCollabWrites()
    expect(await savedNodes(flowId)).toEqual(['n1'])

    // 副本 B 完全不知道 A 的存在（pub/sub 断了就是这个样子）
    const b = docWith(['n2'])
    await storeFlowState(room, b)
    await flushCollabWrites()

    // 覆盖写的话这里只剩 n2
    expect(await savedNodes(flowId)).toEqual(['n1', 'n2'])

    await forgetFlow(room)
  })

  it('合并是双向的：落一次库，本副本的内存文档也补上了对方的内容', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)

    const a = docWith(['n1'])
    await storeFlowState(room, a)
    await flushCollabWrites()

    const b = docWith(['n2'])
    await storeFlowState(room, b)
    await flushCollabWrites()

    // 落库顺手把库里那份灌回了内存 —— 本实例的客户端也就看得到 n1 了
    expect([...nodesMap(b).keys()].sort()).toEqual(['n1', 'n2'])

    await forgetFlow(room)
  })

  it('CAS 撞车 → 重读重来，内容不丢', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    // 第一次假装被别的实例抢先写了
    const update = vi.spyOn(prisma.flow, 'updateMany')
    update.mockResolvedValueOnce({ count: 0 })

    await storeFlowState(room, doc)
    await flushCollabWrites()

    // 重试那一次是真写，所以最终内容完整
    expect(await savedNodes(flowId)).toEqual(['n1'])
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(2)

    await forgetFlow(room)
  })

  it('连续撞车 → 抛出去，交给欠账重试，内容留在内存', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    vi.spyOn(prisma.flow, 'updateMany').mockResolvedValue({ count: 0 })

    await expect(storeFlowState(room, doc)).rejects.toThrow(/被抢先写入/)
    expect(failedStoreCount()).toBe(1)

    await forgetFlow(room)
  })

  it('revision 每次落库都往前走 —— CAS 的比较基准就是它', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    await storeFlowState(room, doc)
    await flushCollabWrites()
    const first = (await row(flowId)).revision

    doc.transact(() => {
      const node = new Y.Map<unknown>()
      node.set('position', { x: 1, y: 1 })
      node.set('data', new Y.Map<unknown>())
      nodesMap(doc).set('n2', node)
    })
    await storeFlowState(room, doc)
    await flushCollabWrites()

    expect((await row(flowId)).revision).toBe(first + 1)
    await forgetFlow(room)
  })

  it('画布已被删 → 静静收工，不抛也不记欠账', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    await prisma.flow.update({ where: { id: flowId }, data: { deletedAt: new Date() } })

    await expect(storeFlowState(room, doc)).resolves.toBeUndefined()
    expect(failedStoreCount()).toBe(0)

    await forgetFlow(room)
  })
})


/**
 * 落库状态的通知（docs/19 §4.4）。
 *
 * 「同步」和「保存」是两件事：内容进了服务端内存、也广播给了同房间的人，
 * 连接层面毫无异常 —— 不说一声的话界面会一直写着「已同步」，而字节其实悬着。
 * 这组用例钉的是**什么时候该说、什么时候不该说**。
 */
describe('落库状态通知', () => {
  beforeEach(async () => {
    await resetDb()
    await retryFailedStores()
  })

  afterEach(() => {
    onStoreStateChange(null)
    vi.restoreAllMocks()
  })

  /** 收集通知，形如 ['flow:x:false', 'flow:x:true'] */
  function collect(): string[] {
    const seen: string[] = []
    onStoreStateChange((room, ok) => seen.push(`${room}:${ok}`))
    return seen
  }

  it('第一次失败通知一次，恢复之后再通知一次', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])
    const seen = collect()

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('炸了'))
    await expect(storeFlowState(room, doc)).rejects.toThrow()
    expect(seen).toEqual([`${room}:false`])

    write.mockRestore()
    await retryFailedStores()
    await flushCollabWrites()
    expect(seen).toEqual([`${room}:false`, `${room}:true`])

    await forgetFlow(room)
  })

  /**
   * 只在**翻转**时说。落库正常时是 2–10 秒一次，逐次通知等于往房间里灌噪音；
   * 一直失败时逐次通知同样没有新信息。
   */
  it('连续失败只通知一次，连续成功一次都不通知', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])
    const seen = collect()

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('炸了'))
    await expect(storeFlowState(room, doc)).rejects.toThrow()
    await expect(storeFlowState(room, doc)).rejects.toThrow()
    await expect(storeFlowState(room, doc)).rejects.toThrow()
    expect(seen).toEqual([`${room}:false`])

    write.mockRestore()
    await forgetFlow(room)
    await storeFlowState(room, doc)
    await flushCollabWrites()
    const afterRecovery = [...seen]

    // 再存两次都成功 —— 状态没变，不该再有通知
    doc.transact(() => nodesMap(doc).delete('n1'))
    await storeFlowState(room, doc)
    await flushCollabWrites()
    expect(seen).toEqual(afterRecovery)

    await forgetFlow(room)
  })

  /** 观察者是旁观者，不是写入路径的一环 —— 它抛异常不该把落库带崩 */
  it('通知回调抛异常不影响落库', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    onStoreStateChange(() => {
      throw new Error('广播失败')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValueOnce(new Error('炸了'))
    // 抛的仍是落库那个异常，不是广播那个
    await expect(storeFlowState(room, doc)).rejects.toThrow('炸了')

    write.mockRestore()
    await expect(storeFlowState(room, doc)).resolves.toBeUndefined()
    await flushCollabWrites()
    expect(failedStoreCount()).toBe(0)

    await forgetFlow(room)
  })

  it('isStoreFailing 报得出当前欠着的房间 —— 新连接靠它补发通知', async () => {
    const flowId = await newFlow()
    const room = roomOf(flowId)
    const doc = docWith(['n1'])

    expect(isStoreFailing(room)).toBe(false)

    const write = vi.spyOn(prisma.flow, 'updateMany').mockRejectedValue(new Error('炸了'))
    await expect(storeFlowState(room, doc)).rejects.toThrow()
    expect(isStoreFailing(room)).toBe(true)

    write.mockRestore()
    await retryFailedStores()
    expect(isStoreFailing(room)).toBe(false)

    await forgetFlow(room)
  })
})
