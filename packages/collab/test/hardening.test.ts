import { Cluster, createMemoryBackend } from '@learning/cluster'
import { edgesMap, nodesMap } from '@learning/contracts/flow-doc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { AwarenessClaims, enforceIdentity } from '../src/awareness.js'
import { isRelayedUpdate } from '../src/collab-server.js'
import { pruneDanglingEdges } from '../src/flow-doc.js'
import { BYTES_CHECK_INTERVAL_OVERSIZED, COLLAB_LIMITS, CollabQuota, HARD_LIMIT_FACTOR } from '../src/quota.js'
import { nodeMap } from './helpers.js'

/** 悬空边、配额、awareness 三道防线背后的纯逻辑。从 `apps/server/test/collab/hardening.test.ts` 移植 */

const memoryCluster = (id = 'instance-a') => new Cluster('single', createMemoryBackend(), id)

function edgeMap(source: string, target: string): Y.Map<unknown> {
  const edge = new Y.Map<unknown>()
  edge.set('source', source)
  edge.set('target', target)
  return edge
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('悬空边清理', () => {
  it('并发「删节点 + 连线」留下的边会被清掉', () => {
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
  let quota: CollabQuota

  beforeEach(() => {
    quota = new CollabQuota(memoryCluster())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function docOfBytes(bytes: number): Y.Doc {
    const doc = new Y.Doc()
    // 先挂进文档再写 label：没整合进文档的 Y.Map 读不出自己的嵌套字段
    nodesMap(doc).set('n1', nodeMap())
    const node = nodesMap(doc).get('n1') as Y.Map<unknown>
    ;(node.get('data') as Y.Map<unknown>).set('label', 'x'.repeat(bytes))
    return doc
  }

  it('正常规模不报警', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', nodeMap())
    expect(quota.check(room, doc)).toBeNull()
    expect(quota.violation(room)).toBeNull()
  })

  it('节点 / 连线再多，只要体积不超就不报警', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      for (let i = 0; i < 5000; i += 1) nodesMap(doc).set(`n${i}`, nodeMap())
      for (let i = 0; i < 9000; i += 1) edgesMap(doc).set(`e${i}`, edgeMap('n0', 'n1'))
    })

    expect(quota.check(room, doc)).toBeNull()
    expect(quota.violation(room)).toBeNull()
    expect(quota.locked(room)).toBeNull()
  })

  it('体积超过软限 → 标记，但不锁写（删除才有路可走）', () => {
    const doc = docOfBytes(COLLAB_LIMITS.document + 1)

    expect(quota.check(room, doc)).toBeNull()
    expect(quota.violation(room)).toMatch(/字节/)
    expect(quota.locked(room)).toBeNull()
  })

  it('删回软限以内 → 下一次复量时解除标记，不用等散场', () => {
    vi.useFakeTimers()
    const doc = docOfBytes(COLLAB_LIMITS.document + 1)
    quota.check(room, doc)
    expect(quota.violation(room)).not.toBeNull()

    nodesMap(doc).delete('n1')
    // 字节数是节流量的：删完当场再问，这一轮根本没复量
    expect(quota.check(room, doc)).toBeNull()
    expect(quota.violation(room)).not.toBeNull()

    vi.advanceTimersByTime(BYTES_CHECK_INTERVAL_OVERSIZED + 1)
    expect(quota.check(room, doc)).toBeNull()
    expect(quota.violation(room)).toBeNull()
  })

  it('顶到硬限 → 锁写，且锁是粘的（删回去也不解，散场重开才重判）', () => {
    vi.useFakeTimers()
    const doc = docOfBytes(Math.ceil(COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) + 1)

    expect(quota.check(room, doc)).toMatch(/硬限/)
    expect(quota.locked(room)).toMatch(/硬限/)

    nodesMap(doc).delete('n1')
    vi.advanceTimersByTime(BYTES_CHECK_INTERVAL_OVERSIZED + 1)
    expect(quota.check(room, doc)).not.toBeNull()
    expect(quota.locked(room)).not.toBeNull()
  })

  it('散场后清掉标记和锁，下次打开重新判', () => {
    const doc = docOfBytes(Math.ceil(COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) + 1)
    quota.check(room, doc)
    expect(quota.locked(room)).not.toBeNull()

    quota.forget(room)
    expect(quota.violation(room)).toBeNull()
    expect(quota.locked(room)).toBeNull()
  })

  it('别的实例锁了写：复量那一拍拉回本地', async () => {
    const backend = createMemoryBackend()
    const here = new CollabQuota(new Cluster('single', backend, 'here'))
    const there = new CollabQuota(new Cluster('single', backend, 'there'))
    there.check(room, docOfBytes(Math.ceil(COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) + 1))

    const small = new Y.Doc()
    here.check(room, small)
    await vi.waitFor(() => expect(here.locked(room)).toMatch(/硬限/))
  })
})

describe('awareness clientID 归属', () => {
  const room = 'flow:claims-test'
  let claims: AwarenessClaims

  beforeEach(() => {
    claims = new AwarenessClaims(memoryCluster())
  })

  function states(entries: Record<number, Record<string, unknown>>) {
    return new Map<number, Record<string, unknown>>(Object.entries(entries).map(([id, state]) => [Number(id), state]))
  }

  it('谁先发布一个 clientID，这个 clientID 就归谁的 socket', async () => {
    const mine = states({ 7: { cursor: { x: 1, y: 2 } } })
    expect(await claims.dropForeignClients(room, 'socket-a', mine)).toBe(0)
    expect(mine.has(7)).toBe(true)
  })

  it('冒用别人 clientID 的条目整条丢弃，自己的照常', async () => {
    await claims.dropForeignClients(room, 'socket-victim', states({ 7: { cursor: { x: 0, y: 0 } } }))

    const forged = states({ 7: { cursor: { x: 999, y: 999 } }, 8: { cursor: { x: 1, y: 1 } } })
    expect(await claims.dropForeignClients(room, 'socket-attacker', forged)).toBe(1)
    expect(forged.has(7)).toBe(false)
    expect(forged.has(8)).toBe(true)
  })

  it('断线释放归属：重连的新 socket 能接着用同一个 clientID', async () => {
    await claims.dropForeignClients(room, 'socket-old', states({ 7: { cursor: { x: 0, y: 0 } } }))
    await claims.releaseSocket(room, 'socket-old')

    const reconnected = states({ 7: { cursor: { x: 3, y: 4 } } })
    expect(await claims.dropForeignClients(room, 'socket-new', reconnected)).toBe(0)
    expect(reconnected.has(7)).toBe(true)
  })

  it('释放只影响那条连接自己认领的号码', async () => {
    await claims.dropForeignClients(room, 'socket-a', states({ 1: {} }))
    await claims.dropForeignClients(room, 'socket-b', states({ 2: {} }))
    await claims.releaseSocket(room, 'socket-a')

    const forged = states({ 2: { cursor: { x: 9, y: 9 } } })
    expect(await claims.dropForeignClients(room, 'socket-c', forged)).toBe(1)
  })

  it('断开之后号码能被重连的新 socket 接着用（房间散场之前一定先断开）', async () => {
    await claims.dropForeignClients(room, 'socket-a', states({ 1: {} }))
    await claims.releaseSocket(room, 'socket-a')
    claims.forgetRoom(room)

    expect(await claims.dropForeignClients(room, 'socket-b', states({ 1: {} }))).toBe(0)
  })

  it('房间在一个副本上散场，别的副本上开着的连接的号码不会被放掉，也就不能被冒用', async () => {
    const backend = createMemoryBackend()
    const replica = (instance: string) => new AwarenessClaims(new Cluster('single', backend, instance))
    const [a, b, c] = [replica('a'), replica('b'), replica('c')]
    await b.dropForeignClients(room, 'b:socket', states({ 1: {} }))

    // 副本 a 上这个房间的人走光了
    await a.dropForeignClients(room, 'a:socket', states({ 2: {} }))
    await a.releaseSocket(room, 'a:socket')
    a.forgetRoom(room)

    expect(await c.dropForeignClients(room, 'c:forger', states({ 1: {} }))).toBe(1)
  })

  it('共享层挂了 → 放行：防冒名的护栏不能把所有人的在场卡死', async () => {
    const fail = () => Promise.reject(new Error('共享层挂了'))
    const broken = new AwarenessClaims({ createMap: () => ({ claim: fail, get: fail, entries: fail, delete: fail, deleteByPrefix: fail }) } as unknown as Cluster)
    const mine = states({ 7: {} })
    expect(await broken.dropForeignClients(room, 'socket-a', mine)).toBe(0)
    await expect(broken.releaseSocket(room, 'socket-a')).resolves.toBeUndefined()
  })
})

describe('awareness 身份防伪', () => {
  const identity = { id: 'u-real', name: '真·张三', avatarUrl: 'https://a/real.png' }

  function states(entries: Record<number, Record<string, unknown>>) {
    return new Map<number, Record<string, unknown>>(Object.entries(entries).map(([id, state]) => [Number(id), state]))
  }

  it('客户端自报的身份被服务端那份覆盖', () => {
    const incoming = states({ 1: { user: { id: 'u-victim', name: '被冒充的人', avatarUrl: 'https://a/fake.png' } } })

    expect(enforceIdentity(incoming, identity)).toBe(1)
    expect(incoming.get(1)?.user).toEqual(identity)
  })

  it('一条消息里夹带多个客户端状态时，每一条都被覆盖', () => {
    const incoming = states({ 1: { user: { id: 'u-a', name: 'a' } }, 2: { user: { id: 'u-b', name: 'b' } } })

    expect(enforceIdentity(incoming, identity)).toBe(2)
    expect(incoming.get(1)?.user).toEqual(identity)
    expect(incoming.get(2)?.user).toEqual(identity)
  })

  it('**不动**光标、选中、拖动几何 —— 那些不是身份', () => {
    const incoming = states({ 1: { user: { id: 'u-fake', name: '假的' }, cursor: { x: 12, y: 34 }, selection: ['node:n1'], transform: { 'node:n1': { x: 5, y: 6 } } } })

    enforceIdentity(incoming, identity)
    expect(incoming.get(1)).toMatchObject({ cursor: { x: 12, y: 34 }, selection: ['node:n1'], transform: { 'node:n1': { x: 5, y: 6 } } })
  })

  it('客户端加的未知字段保留，只有身份三件套被换掉', () => {
    const incoming = states({ 1: { user: { id: 'x', name: 'x', 将来的字段: '保留我' } } })

    enforceIdentity(incoming, identity)
    expect(incoming.get(1)?.user).toEqual({ ...identity, 将来的字段: '保留我' })
  })

  it('没有 user 字段的状态原样放过（离场消息就是这样）', () => {
    const incoming = states({ 1: { cursor: { x: 1, y: 2 } } })

    expect(enforceIdentity(incoming, identity)).toBe(0)
    expect(incoming.get(1)).toEqual({ cursor: { x: 1, y: 2 } })
  })

  it('没有身份（direct connection）时不改写', () => {
    const incoming = states({ 1: { user: { id: 'agent', name: '代理' } } })

    expect(enforceIdentity(incoming, null)).toBe(0)
    expect(incoming.get(1)?.user).toEqual({ id: 'agent', name: '代理' })
  })
})

describe('按条计的副作用跳过转发来的更新', () => {
  it('source 是 redis 才跳过；认不出形状的 origin 算要处理', () => {
    expect(isRelayedUpdate({ source: 'redis' })).toBe(true)
    expect(isRelayedUpdate({ source: 'connection' })).toBe(false)
    expect(isRelayedUpdate({ source: 'local' })).toBe(false)
    expect(isRelayedUpdate('persistence')).toBe(false)
    expect(isRelayedUpdate(null)).toBe(false)
    expect(isRelayedUpdate(undefined)).toBe(false)
  })
})
