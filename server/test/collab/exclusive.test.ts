import { beforeEach, describe, expect, it } from 'vitest'
import { CLOSE_SUPERSEDED } from '../../collab/close.ts'
import {
  claimExclusive,
  enforceExclusive,
  forgetExclusive,
  releaseExclusive,
  type ExclusiveConnection,
  type ExclusiveDocument,
} from '../../collab/exclusive.ts'

/**
 * 单连接互斥：一个用户、一张画布、一条连接，新开的赢。
 *
 * 测的是这条规则本身，不起真的 WebSocket —— `ExclusiveConnection` 已经收窄成
 * 「一条连接」需要的那几个字段，Hocuspocus 的 `Connection` 结构上就是它。
 */

interface FakeConnection extends ExclusiveConnection {
  /** 这条连接被关过几次、带的是什么码 */
  closed: { code: number; reason: string }[]
  /** 底层 socket 有没有被真的关掉 */
  socketClosed: boolean
}

function connection(socketId: string, userId: string | null): FakeConnection {
  const closed: { code: number; reason: string }[] = []
  const fake: FakeConnection = {
    socketId,
    context: { identity: userId ? { id: userId, name: userId, avatarUrl: null } : null },
    webSocket: {
      close(code?: number, reason?: string) {
        fake.socketClosed = true
        void code
        void reason
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
  return {
    name,
    connections: new Map(connections.map((item) => [item, { clients: new Set() }])),
  }
}

/** 「有人打开了这张画布」：登记 + 立即巡检，和服务端 `connected` 里那两步一致 */
async function join(
  document: ExclusiveDocument,
  connection: ExclusiveConnection,
): Promise<number> {
  await claimExclusive(document.name, connection)
  return enforceExclusive([document])
}

function superseded(connection: FakeConnection): boolean {
  return connection.closed.some(
    (event) => event.code === CLOSE_SUPERSEDED.code && event.reason === CLOSE_SUPERSEDED.reason,
  )
}

describe('单连接互斥', () => {
  /**
   * 每个用例一个房间。持有者登记住在共享层（这里是进程内实现），
   * 复用房间名的话上一个用例的登记会漏进下一个 —— 那正是「登记丢了」
   * 那个用例要验证的路径，必须干净。
   */
  let name = ''
  let counter = 0

  beforeEach(() => {
    counter += 1
    name = `flow:exclusive-${counter}`
    forgetExclusive(name)
  })

  it('同一个人开第二个窗口 → 旧窗口下线，新窗口留着', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    const first = room(name, old)
    expect(await join(first, old)).toBe(0)

    const both = room(name, old, fresh)
    expect(await join(both, fresh)).toBe(1)

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
    const other = `${name}-另一张`

    const first = connection('s-1', 'u-1')
    const second = connection('s-2', 'u-1')

    await join(room(name, first), first)
    expect(await join(room(other, second), second)).toBe(0)

    expect(superseded(first)).toBe(false)
    expect(superseded(second)).toBe(false)
  })

  it('没启用登录（辨认不出人）时不做互斥', async () => {
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
    await releaseExclusive(name, 's-old')

    // 旧连接走了之后再巡检若干轮，新连接必须一直活着
    const alone = room(name, fresh)
    expect(await enforceExclusive([alone])).toBe(0)
    expect(await enforceExclusive([alone])).toBe(0)
    expect(superseded(fresh)).toBe(false)
  })

  it('断连事件晚于新窗口登记到达（刷新页面就是这个顺序）也不会误删登记', async () => {
    const old = connection('s-old', 'u-1')
    const fresh = connection('s-new', 'u-1')

    await join(room(name, old), old)
    await join(room(name, old, fresh), fresh)
    // 新窗口已经是持有者了，此刻旧连接的断开事件才姗姗来迟
    await releaseExclusive(name, 's-old')

    expect(await enforceExclusive([room(name, fresh)])).toBe(0)
    expect(superseded(fresh)).toBe(false)
  })

  it('登记丢了（TTL 过期 / 实例崩过）→ 就地补登记，只留一条而不是全踢', async () => {
    const one = connection('s-1', 'u-1')
    const two = connection('s-2', 'u-1')

    // 谁都没登记过，直接巡检：留下一条（遍历到的第一条），另一条顶下线
    expect(await enforceExclusive([room(name, one, two)])).toBe(1)
    expect(superseded(one)).toBe(false)
    expect(superseded(two)).toBe(true)

    // 补上的登记要稳定：留下的那条再巡检多少轮都不该被踢
    expect(await enforceExclusive([room(name, one)])).toBe(0)
  })
})
