import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { edgesMap, nodesMap, pruneDanglingEdges } from '../../collab/flow-doc.ts'
import {
  COLLAB_LIMITS,
  HARD_LIMIT_FACTOR,
  checkQuota,
  forgetQuota,
  quotaLocked,
  quotaViolation,
} from '../../collab/quota.ts'
import {
  dropForeignClients,
  enforceIdentity,
  forgetClaims,
  releaseSocket,
} from '../../collab/awareness.ts'

/**
 * 二期补上的三道防线。前两道靠的是 Hocuspocus 的 hook，这里测的是它们背后的纯逻辑；
 * hook 本身（`beforeHandleMessage` / `beforeHandleAwareness`）只是把这些函数接上去。
 */

function nodeMap(): Y.Map<unknown> {
  const node = new Y.Map<unknown>()
  node.set('position', { x: 0, y: 0 })
  const data = new Y.Map<unknown>()
  data.set('label', 'n')
  node.set('data', data)
  return node
}

function edgeMap(source: string, target: string): Y.Map<unknown> {
  const edge = new Y.Map<unknown>()
  edge.set('source', source)
  edge.set('target', target)
  return edge
}

describe('悬空边清理', () => {
  it('并发「删节点 + 连线」留下的边会被清掉', () => {
    // 两个客户端从同一份状态出发
    const base = new Y.Doc()
    nodesMap(base).set('n1', nodeMap())
    nodesMap(base).set('n2', nodeMap())

    const a = new Y.Doc()
    const b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base))

    nodesMap(a).delete('n2') // 甲删掉 n2
    edgesMap(b).set('e1', edgeMap('n1', 'n2')) // 乙同时连 n1 → n2

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

    // CRDT 把两边都留下了：节点没了，边还在
    expect(edgesMap(a).size).toBe(1)

    expect(pruneDanglingEdges(a)).toBe(1)
    expect(edgesMap(a).size).toBe(0)
  })

  it('端点都在的边不动', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', nodeMap())
    nodesMap(doc).set('n2', nodeMap())
    edgesMap(doc).set('e1', edgeMap('n1', 'n2'))

    expect(pruneDanglingEdges(doc)).toBe(0)
    expect(edgesMap(doc).size).toBe(1)
  })

  it('结构坏掉的边也清掉', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', nodeMap())
    const broken = new Y.Map<unknown>()
    broken.set('source', 'n1') // 缺 target
    edgesMap(doc).set('e-broken', broken)

    expect(pruneDanglingEdges(doc)).toBe(1)
    expect(edgesMap(doc).size).toBe(0)
  })

  it('清理用的是 gc origin —— 不会跑进任何人的撤销栈', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', nodeMap())
    edgesMap(doc).set('e1', edgeMap('n1', '不存在'))

    const origins: unknown[] = []
    doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin))

    pruneDanglingEdges(doc)
    expect(origins).toContain('gc')
  })
})

describe('内容配额', () => {
  const room = 'flow:quota-test'

  beforeEach(() => forgetQuota(room))

  it('正常规模不报警', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', nodeMap())
    expect(checkQuota(room, doc)).toBeNull()
    expect(quotaViolation(room)).toBeNull()
  })

  /** 造一个有 count 个节点的文档 */
  function docWithNodes(count: number): Y.Doc {
    const doc = new Y.Doc()
    const nodes = nodesMap(doc)
    doc.transact(() => {
      for (let i = 0; i < count; i += 1) nodes.set(`n${i}`, nodeMap())
    })
    return doc
  }

  it('节点数超过软限 → 标记，但不锁写（删除才有路可走）', () => {
    const doc = docWithNodes(COLLAB_LIMITS.nodes + 1)

    expect(checkQuota(room, doc)).toBeNull() // 返回值是「锁写原因」，软限不锁
    expect(quotaViolation(room)).toMatch(/节点数/)
    expect(quotaLocked(room)).toBeNull()
  })

  it('连线数超过软限同理', () => {
    const doc = new Y.Doc()
    const edges = edgesMap(doc)
    doc.transact(() => {
      for (let i = 0; i <= COLLAB_LIMITS.edges; i += 1) edges.set(`e${i}`, edgeMap('a', 'b'))
    })

    expect(checkQuota(room, doc)).toBeNull()
    expect(quotaViolation(room)).toMatch(/连线数/)
  })

  it('删回软限以内 → 标记自动解除，不用等散场', () => {
    const doc = docWithNodes(COLLAB_LIMITS.nodes + 1)
    checkQuota(room, doc)
    expect(quotaViolation(room)).not.toBeNull()

    const nodes = nodesMap(doc)
    doc.transact(() => {
      nodes.delete('n0')
      nodes.delete('n1')
    })
    expect(checkQuota(room, doc)).toBeNull()
    expect(quotaViolation(room)).toBeNull()
  })

  it('顶到硬限 → 锁写，且锁是粘的（删回去也不解，散场重开才重判）', () => {
    const doc = docWithNodes(Math.ceil(COLLAB_LIMITS.nodes * HARD_LIMIT_FACTOR) + 1)

    expect(checkQuota(room, doc)).toMatch(/硬限/)
    expect(quotaLocked(room)).toMatch(/硬限/)

    // 锁写状态下本不会有写进来；就算有（比如锁之前已在途），也不解锁
    const nodes = nodesMap(doc)
    doc.transact(() => {
      for (let i = 0; i < 1000; i += 1) nodes.delete(`n${i}`)
    })
    expect(checkQuota(room, doc)).not.toBeNull()
    expect(quotaLocked(room)).not.toBeNull()
  })

  it('散场后清掉标记和锁，下次打开重新判', () => {
    const doc = docWithNodes(Math.ceil(COLLAB_LIMITS.nodes * HARD_LIMIT_FACTOR) + 1)
    checkQuota(room, doc)
    expect(quotaLocked(room)).not.toBeNull()

    forgetQuota(room)
    expect(quotaViolation(room)).toBeNull()
    expect(quotaLocked(room)).toBeNull()
  })
})

describe('awareness clientID 归属', () => {
  const room = 'flow:claims-test'

  beforeEach(() => forgetClaims(room))

  function states(entries: Record<number, Record<string, unknown>>) {
    return new Map<number, Record<string, unknown>>(
      Object.entries(entries).map(([id, state]) => [Number(id), state]),
    )
  }

  it('谁先发布一个 clientID，这个 clientID 就归谁的 socket', async () => {
    const mine = states({ 7: { cursor: { x: 1, y: 2 } } })
    expect(await dropForeignClients(room, 'socket-a', mine)).toBe(0)
    expect(mine.has(7)).toBe(true)
  })

  it('冒用别人 clientID 的条目整条丢弃，自己的照常', async () => {
    await dropForeignClients(room, 'socket-victim', states({ 7: { cursor: { x: 0, y: 0 } } }))

    const forged = states({
      7: { cursor: { x: 999, y: 999 } }, // 冒用 victim 的 7 号
      8: { cursor: { x: 1, y: 1 } }, // 自己的 8 号
    })
    expect(await dropForeignClients(room, 'socket-attacker', forged)).toBe(1)
    expect(forged.has(7)).toBe(false)
    expect(forged.has(8)).toBe(true)
  })

  it('断线释放归属：重连的新 socket 能接着用同一个 clientID', async () => {
    await dropForeignClients(room, 'socket-old', states({ 7: { cursor: { x: 0, y: 0 } } }))
    await releaseSocket(room, 'socket-old')

    const reconnected = states({ 7: { cursor: { x: 3, y: 4 } } })
    expect(await dropForeignClients(room, 'socket-new', reconnected)).toBe(0)
    expect(reconnected.has(7)).toBe(true)
  })

  it('释放只影响那条连接自己认领的号码', async () => {
    await dropForeignClients(room, 'socket-a', states({ 1: {} }))
    await dropForeignClients(room, 'socket-b', states({ 2: {} }))
    await releaseSocket(room, 'socket-a')

    // b 的 2 号还归 b，别人依然冒用不了
    const forged = states({ 2: { cursor: { x: 9, y: 9 } } })
    expect(await dropForeignClients(room, 'socket-c', forged)).toBe(1)
  })

  it('房间散场后整张登记表作废', async () => {
    await dropForeignClients(room, 'socket-a', states({ 1: {} }))
    await forgetClaims(room)

    expect(await dropForeignClients(room, 'socket-b', states({ 1: {} }))).toBe(0)
  })
})

describe('awareness 身份防伪', () => {
  const identity = { id: 'u-real', name: '真·张三', avatarUrl: 'https://a/real.png' }

  /** 模拟一条 awareness 更新：clientId → 该客户端上报的状态 */
  function states(entries: Record<number, Record<string, unknown>>) {
    return new Map<number, Record<string, unknown>>(
      Object.entries(entries).map(([id, state]) => [Number(id), state]),
    )
  }

  it('客户端自报的身份被服务端那份覆盖', () => {
    const incoming = states({
      1: { user: { id: 'u-victim', name: '被冒充的人', avatarUrl: 'https://a/fake.png' } },
    })

    expect(enforceIdentity(incoming, identity)).toBe(1)
    expect(incoming.get(1)!.user).toEqual(identity)
  })

  it('一条消息里夹带多个客户端状态时，每一条都被覆盖', () => {
    const incoming = states({
      1: { user: { id: 'u-a', name: 'a' } },
      2: { user: { id: 'u-b', name: 'b' } },
    })

    expect(enforceIdentity(incoming, identity)).toBe(2)
    expect(incoming.get(1)!.user).toEqual(identity)
    expect(incoming.get(2)!.user).toEqual(identity)
  })

  it('**不动**光标、选中、拖动几何 —— 那些不是身份', () => {
    const incoming = states({
      1: {
        user: { id: 'u-fake', name: '假的' },
        cursor: { x: 12, y: 34 },
        selection: ['node:n1'],
        transform: { 'node:n1': { x: 5, y: 6 } },
      },
    })

    enforceIdentity(incoming, identity)
    const state = incoming.get(1)!
    expect(state.cursor).toEqual({ x: 12, y: 34 })
    expect(state.selection).toEqual(['node:n1'])
    expect(state.transform).toEqual({ 'node:n1': { x: 5, y: 6 } })
  })

  it('客户端加的未知字段保留，只有身份三件套被换掉', () => {
    const incoming = states({ 1: { user: { id: 'x', name: 'x', 将来的字段: '保留我' } } })

    enforceIdentity(incoming, identity)
    expect(incoming.get(1)!.user).toEqual({ ...identity, 将来的字段: '保留我' })
  })

  it('没有 user 字段的状态原样放过（离场消息就是这样）', () => {
    const incoming = states({ 1: { cursor: { x: 1, y: 2 } } })

    expect(enforceIdentity(incoming, identity)).toBe(0)
    expect(incoming.get(1)).toEqual({ cursor: { x: 1, y: 2 } })
  })

  it('没启用登录（identity 为 null）时不改写 —— 本地裸跑照常', () => {
    const incoming = states({ 1: { user: { id: 'dev', name: '本地' } } })

    expect(enforceIdentity(incoming, null)).toBe(0)
    expect(incoming.get(1)!.user).toEqual({ id: 'dev', name: '本地' })
  })
})
