import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { edgesMap, nodesMap } from '../../collab/flow-doc.ts'
import { applyFlowUpdate, readFlowUpdate } from '../../collab/flow-writer.ts'
import { forgetFlow, roomOf } from '../../collab/persistence.ts'
import { COLLAB_LIMITS } from '../../collab/quota.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * 个人画布的写入通道（REQ-SOLO）。
 *
 * 这条路没有房间、没有 WebSocket，一次 HTTP 就是一次「读库 → 合并 → 写回」，
 * 所以要盯住的正是协同那边由 CRDT 连接层白送的几件事：重发要幂等、
 * 两个标签页的改动都得在、超限的整段要拒掉而不是写一半。
 */

async function newFlow() {
  const alice = await actor()
  const projectId = await createProject(alice)
  return createFlow(alice, projectId)
}

/** 造一段「往画布里加这些节点」的增量 */
function addNodes(...ids: string[]): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of ids) {
      const node = new Y.Map<unknown>()
      node.set('position', { x: 0, y: 0 })
      const data = new Y.Map<unknown>()
      data.set('label', id)
      node.set('data', data)
      nodesMap(doc).set(id, node)
    }
  })
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

/** 把库里那份 ydoc 读成一个文档 */
async function docInDb(flowId: string): Promise<Y.Doc> {
  const row = await prisma.flow.findUniqueOrThrow({
    where: { id: flowId },
    select: { ydoc: true },
  })
  const doc = new Y.Doc()
  if (row.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc))
  return doc
}

async function nodeIds(flowId: string): Promise<string[]> {
  const doc = await docInDb(flowId)
  const ids = [...nodesMap(doc).keys()].sort()
  doc.destroy()
  return ids
}

describe('个人画布的写入通道', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('推一段增量 → 内容落库、投影跟着更新', async () => {
    const flowId = await newFlow()

    const result = await applyFlowUpdate(flowId, addNodes('n1', 'n2'))

    expect(result.ok).toBe(true)
    expect(await nodeIds(flowId)).toEqual(['n1', 'n2'])

    const row = await prisma.flow.findUniqueOrThrow({
      where: { id: flowId },
      select: { nodeCount: true, graph: true, revision: true },
    })
    // 协同那边投影要等散场，这边每次都写 —— 列表页的计数不能等人离开画布
    expect(row.nodeCount).toBe(2)
    expect(JSON.parse(row.graph).nodes).toHaveLength(2)
    expect(row.revision).toBe(1)

    await forgetFlow(roomOf(flowId))
  })

  it('同一段增量推两次 → 第二次是 noop，不写库', async () => {
    const flowId = await newFlow()
    const update = addNodes('n1')

    await applyFlowUpdate(flowId, update)
    const again = await applyFlowUpdate(flowId, update)

    expect(again.ok && again.noop).toBe(true)
    expect(await nodeIds(flowId)).toEqual(['n1'])
    // revision 没涨：重发是真的什么都没发生
    const row = await prisma.flow.findUniqueOrThrow({
      where: { id: flowId },
      select: { revision: true },
    })
    expect(row.revision).toBe(1)

    await forgetFlow(roomOf(flowId))
  })

  it('两个标签页各推各的 → 改动都在，谁也没被抹掉', async () => {
    const flowId = await newFlow()

    // 两边都从空画布出发，互不知道对方 —— 覆盖式写回会丢掉先到的那个
    await Promise.all([
      applyFlowUpdate(flowId, addNodes('from-tab-a')),
      applyFlowUpdate(flowId, addNodes('from-tab-b')),
    ])

    expect(await nodeIds(flowId)).toEqual(['from-tab-a', 'from-tab-b'])

    await forgetFlow(roomOf(flowId))
  })

  it('增量基于服务端返回的状态向量算 → 只发差量也能合并对', async () => {
    const flowId = await newFlow()

    const first = await applyFlowUpdate(flowId, addNodes('n1'))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // 客户端拿着服务端给的基线，只把新加的那个节点算成差量
    const local = new Y.Doc()
    Y.applyUpdate(local, (await readFlowUpdate(flowId))?.update ?? new Uint8Array())
    const node = new Y.Map<unknown>()
    node.set('position', { x: 1, y: 1 })
    node.set('data', new Y.Map<unknown>())
    nodesMap(local).set('n2', node)
    const diff = Y.encodeStateAsUpdate(local, first.stateVector)
    local.destroy()

    await applyFlowUpdate(flowId, diff)

    expect(await nodeIds(flowId)).toEqual(['n1', 'n2'])
    await forgetFlow(roomOf(flowId))
  })

  it('端点已经不在的连线被清掉，且不进审计', async () => {
    const flowId = await newFlow()
    await applyFlowUpdate(flowId, addNodes('n1'))

    // 连一条指向不存在节点的边 —— 一个人开两个标签页也造得出来
    const doc = new Y.Doc()
    doc.transact(() => {
      const edge = new Y.Map<unknown>()
      edge.set('source', 'n1')
      edge.set('target', 'ghost')
      edgesMap(doc).set('e1', edge)
    })
    await applyFlowUpdate(flowId, Y.encodeStateAsUpdate(doc))
    doc.destroy()

    const stored = await docInDb(flowId)
    expect(edgesMap(stored).size).toBe(0)
    stored.destroy()

    await forgetFlow(roomOf(flowId))
  })

  it('合并之后超过体积上限 → 整段拒掉，库里一个节点都没多', async () => {
    const flowId = await newFlow()
    await applyFlowUpdate(flowId, addNodes('keep'))

    /*
     * 单次推送另有 `COLLAB_LIMITS.message`（1MB）那道关，所以一发请求撑不爆文档 ——
     * 要够到体积上限得推上二十来次。直接把库里那份做大，等价于「已经推到那个规模了」，
     * 测的是合并之后的判定，不是怎么长到那儿的。
     */
    const fat = new Y.Doc()
    const node = new Y.Map<unknown>()
    node.set('position', { x: 0, y: 0 })
    const data = new Y.Map<unknown>()
    data.set('label', 'x'.repeat(COLLAB_LIMITS.document + 1))
    node.set('data', data)
    nodesMap(fat).set('big', node)
    await prisma.flow.update({
      where: { id: flowId },
      data: { ydoc: Buffer.from(Y.encodeStateAsUpdate(fat)) },
    })
    fat.destroy()

    const result = await applyFlowUpdate(flowId, addNodes('n1'))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('too-large')
    // 拒绝就是拒绝：没有写一半
    expect(await nodeIds(flowId)).toEqual(['big'])

    await forgetFlow(roomOf(flowId))
  })

  it('单条消息超过字节上限 → 连读库都不用', async () => {
    const flowId = await newFlow()

    const huge = new Uint8Array(COLLAB_LIMITS.message + 1)
    const result = await applyFlowUpdate(flowId, huge)

    expect(result.ok === false && result.reason).toBe('too-large')
    await forgetFlow(roomOf(flowId))
  })

  it('画布不存在 / 已软删 → not-found', async () => {
    const flowId = await newFlow()
    await prisma.flow.update({ where: { id: flowId }, data: { deletedAt: new Date() } })

    const deleted = await applyFlowUpdate(flowId, addNodes('n1'))
    expect(deleted.ok === false && deleted.reason).toBe('not-found')

    const missing = await applyFlowUpdate('no-such-flow', addNodes('n1'))
    expect(missing.ok === false && missing.reason).toBe('not-found')
  })

  it('读回来的差量只带没见过的部分', async () => {
    const flowId = await newFlow()
    const first = await applyFlowUpdate(flowId, addNodes('n1'))
    if (!first.ok) throw new Error('第一次推送就失败了')

    const full = await readFlowUpdate(flowId)
    const diff = await readFlowUpdate(flowId, first.stateVector)
    if (!full || !diff) throw new Error('读不到画布状态')
    // 已经同步到最新的客户端只会拿到一段近乎空的更新
    expect(diff.update.byteLength).toBeLessThan(full.update.byteLength)
    // 状态向量给的是**服务端自己的**进度：客户端拿它当基线，离线时攒的改动才推得出去
    expect(full.stateVector).toEqual(first.stateVector)

    expect(await readFlowUpdate('no-such-flow')).toBeNull()
    await forgetFlow(roomOf(flowId))
  })
})

/**
 * 写回时被别的实例抢先（`revision` 的 CAS）。
 *
 * **单进程内撞不上这一支**：`applyFlowUpdate` 把「读-合并-写回」整个塞进了每张画布
 * 一条的写队列，所以同实例的并发是排开的，第二次读到的永远是第一次写完的状态。
 * 只有多副本才会两边各读各的、后写的盖掉先写的 —— 那正是这道 CAS 要挡的事，
 * 而它也因此没有任何自然发生的测试能覆盖到。
 *
 * 所以这里**人为制造**那个瞬间：在 `findFirst` 返回之后、写回之前，
 * 从旁边直接写一次库（绕开队列，就像另一个实例干的）。
 */
describe('写回撞车时的重试', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 扮演「另一个实例」：不走队列、不走 applyFlowUpdate，直接读改写 + 涨 revision */
  async function writeFromOtherInstance(flowId: string, update: Uint8Array) {
    // 用 findUnique 而不是 findFirst：后者正被 spy 着，会把自己也绕进去
    const row = await prisma.flow.findUniqueOrThrow({
      where: { id: flowId },
      select: { ydoc: true },
    })
    const doc = new Y.Doc()
    if (row.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc))
    Y.applyUpdate(doc, update)
    await prisma.flow.update({
      where: { id: flowId },
      data: { ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), revision: { increment: 1 } },
    })
    doc.destroy()
  }

  /**
   * 每次 `findFirst` 返回之后就插一次别人的写。
   * @param times 插几次；`Infinity` 就是每次都插（用来把重试耗光）
   */
  function raceOnRead(flowId: string, update: Uint8Array, times: number) {
    const real = prisma.flow.findFirst.bind(prisma.flow)
    let done = 0

    const impl = async (...args: Parameters<typeof real>) => {
      const row = await real(...args)
      if (done < times) {
        done += 1
        await writeFromOtherInstance(flowId, update)
      }
      return row
    }

    /*
     * 断言一下类型：Prisma 的 `findFirst` 返回的不是普通 Promise，而是还挂着
     * `.project()` 这些关系方法的 fluent client。被测代码只 await 它，
     * 用不到那些方法，所以给个普通的 async 函数就够了。
     */
    return vi
      .spyOn(prisma.flow, 'findFirst')
      .mockImplementation(impl as unknown as typeof prisma.flow.findFirst)
  }

  it('被抢先一次 → 重读重来，两边的改动都在', async () => {
    const flowId = await newFlow()
    await applyFlowUpdate(flowId, addNodes('base'))

    const spy = raceOnRead(flowId, addNodes('from-other-instance'), 1)
    const result = await applyFlowUpdate(flowId, addNodes('mine'))

    // 第一次写回扑空（CAS 没命中），重读之后才成功 —— 两次读就是这条分支的证据
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.ok && result.noop).toBe(false)

    // 谁的都没丢：抢先那位的节点在，我的也在
    expect(await nodeIds(flowId)).toEqual(['base', 'from-other-instance', 'mine'].sort())

    const row = await prisma.flow.findUniqueOrThrow({
      where: { id: flowId },
      select: { revision: true },
    })
    // base=1、别的实例=2、我的=3；返回值要和库里对得上，客户端拿它判断有没有别人在写
    expect(row.revision).toBe(3)
    expect(result.ok && result.revision).toBe(3)

    await forgetFlow(roomOf(flowId))
  })

  it('一直被抢先 → 抛错，而不是假装写成功', async () => {
    const flowId = await newFlow()
    await applyFlowUpdate(flowId, addNodes('base'))

    raceOnRead(flowId, addNodes('always-losing'), Number.POSITIVE_INFINITY)

    /*
     * 耗尽重试必须**抛**：路由会变成 500，客户端把它当网络错误、保持「未保存」并稍后重试，
     * 改动还在本地 IndexedDB 里。要是这里改成返回 ok，客户端会把 ack 往前推 ——
     * 那段内容就再也补不回来了，而界面一直显示「已保存」。
     */
    await expect(applyFlowUpdate(flowId, addNodes('mine'))).rejects.toThrow(/抢先写入/)

    // 我的那段确实没进库
    expect(await nodeIds(flowId)).not.toContain('mine')

    await forgetFlow(roomOf(flowId))
  })
})
