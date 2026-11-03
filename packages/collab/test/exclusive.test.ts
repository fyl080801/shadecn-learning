import { Cluster, createMemoryBackend } from '@learning/cluster'
import { CLOSE_SUPERSEDED } from '@learning/contracts/collab'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExclusiveConnections, type ExclusiveConnection, type ExclusiveDocument } from '../src/exclusive.js'

/** 单连接互斥：一个用户、一张画布、一条连接，新开的赢。从 `apps/server/test/collab/exclusive.test.ts` 移植，真连接的版本在 `provider.test.ts` */

interface FakeConnection extends ExclusiveConnection {
  closed: { code: number; reason: string }[]
  socketClosed: boolean
}

function connection(socketId: string, userId: string | null): FakeConnection {
  const closed: { code: number; reason: string }[] = []
  const fake: FakeConnection = {
    socketId,
    context: { identity: userId ? { id: userId, name: userId, avatarUrl: null } : null },
    webSocket: {
      close() {
        fake.socketClosed = true
      },
    },
    close(event) {
      closed.push(event)
    },
    closed,
    socketClosed: false,
  }
  return fake
}

function room(name: string, ...connections: FakeConnection[]): ExclusiveDocument {
  return { name, connections: new Map(connections.map((item) => [item, { clients: new Set() }])) }
}

const superseded = (item: FakeConnection) => item.closed.some((event) => event.code === CLOSE_SUPERSEDED.code && event.reason === CLOSE_SUPERSEDED.reason)

describe('单连接互斥', () => {
  const name = 'flow:exclusive'
  let exclusive: ExclusiveConnections

  /** 「有人打开了这张画布」：登记 + 立即巡检，和 `connected` 里那两步一致 */
  async function join(document: ExclusiveDocument, item: ExclusiveConnection): Promise<number> {
    await exclusive.claim(document.name, item)
    return exclusive.enforce([document])
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    exclusive = new ExclusiveConnections(new Cluster('single', createMemoryBackend(), 'instance-a'))
  })

  it('同一个人开第二个窗口 → 旧窗口下线，新窗口留着', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    expect(await join(room(name, old), old)).toBe(0)
    expect(await join(room(name, old, fresh), fresh)).toBe(1)

    expect(superseded(old)).toBe(true)
    expect(superseded(fresh)).toBe(false)
  })

  it('顶下线要真的关掉 socket —— 否则旧窗口下一条消息就把自己接回来了', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    await join(room(name, old), old)
    await join(room(name, old, fresh), fresh)

    expect(old.socketClosed).toBe(true)
    expect(fresh.socketClosed).toBe(false)
  })

  it('两个人各开各的，谁也不踢谁', async () => {
    const a = connection('s-a', 'u-a')
    const b = connection('s-b', 'u-b')

    await join(room(name, a), a)
    expect(await join(room(name, a, b), b)).toBe(0)
    expect(superseded(a)).toBe(false)
    expect(superseded(b)).toBe(false)
  })

  it('互斥只在同一张画布内 —— 同时开着两张画布是正常工作方式', async () => {
    const first = connection('s-1', 'u-1')
    const second = connection('s-2', 'u-1')

    await join(room(name, first), first)
    expect(await join(room(`${name}-另一张`, second), second)).toBe(0)
    expect(superseded(first)).toBe(false)
    expect(superseded(second)).toBe(false)
  })

  it('认不出人的连接（direct connection 没有身份）不做互斥', async () => {
    const one = connection('s-1', null)
    const two = connection('s-2', null)

    await join(room(name, one), one)
    expect(await join(room(name, one, two), two)).toBe(0)
    expect(superseded(one)).toBe(false)
  })

  it('旧连接断开后，剩下那条不会被误踢', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    await join(room(name, old), old)
    await join(room(name, old, fresh), fresh)
    await exclusive.release(name, 's-old')

    const alone = room(name, fresh)
    expect(await exclusive.enforce([alone])).toBe(0)
    expect(await exclusive.enforce([alone])).toBe(0)
    expect(superseded(fresh)).toBe(false)
  })

  it('断连事件晚于新窗口登记到达（刷新页面就是这个顺序）也不会误删登记', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    await join(room(name, old), old)
    await join(room(name, old, fresh), fresh)
    // 新窗口已经是持有者了，此刻旧连接的断开事件才姗姗来迟
    await exclusive.release(name, 's-old')

    // 登记还在且是新窗口的：另一个实例上的旧连接照样会被顶掉
    const stale = connection('s-stale', 'u-1')
    expect(await exclusive.enforce([room(name, fresh, stale)])).toBe(1)
    expect(superseded(stale)).toBe(true)
    expect(superseded(fresh)).toBe(false)
  })

  it('登记丢了（TTL 过期 / 实例崩过）→ 就地补登记，只留一条而不是全踢', async () => {
    const one = connection('s-1', 'u-1')
    const two = connection('s-2', 'u-1')

    expect(await exclusive.enforce([room(name, one, two)])).toBe(1)
    expect(superseded(one)).toBe(false)
    expect(superseded(two)).toBe(true)
    expect(await exclusive.enforce([room(name, one)])).toBe(0)
  })

  it('持有者在别的实例上：本地全踢，不改登记（否则两个实例互相踢）', async () => {
    const backend = createMemoryBackend()
    const here = new ExclusiveConnections(new Cluster('single', backend, 'here'))
    const there = new ExclusiveConnections(new Cluster('single', backend, 'there'))
    const local = connection('same-id', 'u-1')
    const remote = connection('same-id', 'u-1')

    await here.claim(name, local)
    await there.claim(name, remote)

    // socketId 相同也分得开：比对的是带实例前缀的标识。持有者是后来的 there
    expect(await here.enforce([room(name, local)])).toBe(1)
    expect(superseded(local)).toBe(true)
    expect(await there.enforce([room(name, remote)])).toBe(0)
    expect(superseded(remote)).toBe(false)
  })

  it('共享层读不到 → 本轮放行，不把人踢下线', async () => {
    const holders = { get: () => Promise.reject(new Error('共享层挂了')), set: () => Promise.reject(new Error('共享层挂了')), deleteIfEquals: () => Promise.reject(new Error('共享层挂了')) }
    const broken = new ExclusiveConnections({ instanceId: 'x', createMap: () => holders } as unknown as Cluster)
    const one = connection('s-1', 'u-1')
    const two = connection('s-2', 'u-1')

    await broken.claim(name, one)
    expect(await broken.enforce([room(name, one, two)])).toBe(0)
    await expect(broken.release(name, 's-1')).resolves.toBeUndefined()
  })
})
