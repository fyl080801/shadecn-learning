import { describe, expect, it, vi } from 'vitest'
import {
  SYNC_MESSAGE_TYPES,
  createWriteGate,
  isWriteSync,
  type AuthorizeWrite,
  type WriteVerdict,
} from '../../collab/write-gate.ts'

/**
 * 写操作的认证闸门（`beforeSync` 背后的纯逻辑；hook 本身只是把它接上去）。
 *
 * 它要保证的事：登录态没了、或人已经被移出项目之后，后续的写帧在**进 Y.Doc 之前**
 * 就被判死 —— 不是等复验把连接踢掉，因为那之间的每一帧都会被应用、广播、落库，
 * 而且别人撤销不回来。
 */

/** 可控的时钟：TTL 是这套东西的核心，不能靠真实时间去等 */
function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

/** 记账用的假鉴权：查了几次、每次答什么 */
function stubAuthorize(answers: WriteVerdict[] | WriteVerdict = null) {
  const queue = Array.isArray(answers) ? [...answers] : null
  const fixed = Array.isArray(answers) ? null : answers
  const calls: { cookie: string | null; room: string }[] = []

  const authorize: AuthorizeWrite = async (cookie, room) => {
    calls.push({ cookie, room })
    if (queue) return queue.length > 1 ? (queue.shift() as WriteVerdict) : (queue[0] as WriteVerdict)
    return fixed
  }

  return { authorize, calls }
}

describe('写帧识别', () => {
  it('SyncStep2 和 Update 是写 —— 这两条会改文档', () => {
    expect(isWriteSync(SYNC_MESSAGE_TYPES.step2)).toBe(true)
    expect(isWriteSync(SYNC_MESSAGE_TYPES.update)).toBe(true)
  })

  it('SyncStep1 是读，不拦 —— 拦了连重连时的同步握手都做不成', () => {
    expect(isWriteSync(SYNC_MESSAGE_TYPES.step1)).toBe(false)
  })

  it('认不出的类型不当成写 —— 拦截只针对确定会改文档的那两种', () => {
    expect(isWriteSync(99)).toBe(false)
  })
})

describe('写入闸门', () => {
  it('登录态还在 → 放行', async () => {
    const { authorize } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    expect(await gate.check('s1', 'flow:f1', 'sid=x')).toBeNull()
  })

  it('登录态没了 → 判 unauthorized，前端据此弹重新登录框', async () => {
    const { authorize } = stubAuthorize('unauthorized')
    const gate = createWriteGate({ authorize })

    expect(await gate.check('s1', 'flow:f1', 'sid=x')).toBe('unauthorized')
  })

  it('被移出项目 → 判 forbidden，和「该重新登录」区分开', async () => {
    const { authorize } = stubAuthorize('forbidden')
    const gate = createWriteGate({ authorize })

    expect(await gate.check('s1', 'flow:f1', 'sid=x')).toBe('forbidden')
  })

  it('把 cookie 和房间名原样交给注入的检查 —— 闸门自己不认识「项目」', async () => {
    const { authorize, calls } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    await gate.check('s1', 'flow:f1', 'sid=abc')

    expect(calls).toEqual([{ cookie: 'sid=abc', room: 'flow:f1' }])
  })
})

describe('判定缓存', () => {
  it('TTL 之内只查一次库 —— 连续编辑不该每帧打一次数据库', async () => {
    const time = clock()
    const { authorize, calls } = stubAuthorize(null)
    const gate = createWriteGate({ authorize, now: time.now, ttlMs: 10_000 })

    for (let i = 0; i < 20; i += 1) {
      time.advance(100) // 两秒里发了 20 帧
      expect(await gate.check('s1', 'flow:f1', 'sid=x')).toBeNull()
    }

    expect(calls).toHaveLength(1)
  })

  it('TTL 过了重新查 —— 这是登录态过期的兜底发现路径', async () => {
    const time = clock()
    const { authorize, calls } = stubAuthorize(['unauthorized'])
    const gate = createWriteGate({ authorize, now: time.now, ttlMs: 10_000 })

    // 先放行一次并缓存
    const first = stubAuthorize(null)
    const warm = createWriteGate({ authorize: first.authorize, now: time.now, ttlMs: 10_000 })
    expect(await warm.check('s1', 'flow:f1', null)).toBeNull()
    time.advance(9_999)
    expect(await warm.check('s1', 'flow:f1', null)).toBeNull()
    expect(first.calls).toHaveLength(1)

    time.advance(2)
    expect(await warm.check('s1', 'flow:f1', null)).toBeNull()
    expect(first.calls).toHaveLength(2)

    // 过期之后答案变了就跟着变
    expect(await gate.check('s2', 'flow:f1', null)).toBe('unauthorized')
    expect(calls).toHaveLength(1)
  })

  it('每条连接各缓存各的 —— 一个人被拒不影响同房间的其他人', async () => {
    const { authorize, calls } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    await gate.check('s1', 'flow:f1', 'sid=a')
    await gate.check('s2', 'flow:f1', 'sid=b')

    expect(calls).toHaveLength(2)
    expect(gate.size()).toBe(2)
  })

  it('同一条连接的并发写帧只触发一次查询 —— 缓存的是 promise，顺带去重', async () => {
    const { authorize, calls } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    await Promise.all([
      gate.check('s1', 'flow:f1', null),
      gate.check('s1', 'flow:f1', null),
      gate.check('s1', 'flow:f1', null),
    ])

    expect(calls).toHaveLength(1)
  })
})

describe('缓存失效', () => {
  it('握手预填之后第一个写帧不查库 —— onConnect 刚认证过', async () => {
    const { authorize, calls } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    gate.prime('s1')

    expect(await gate.check('s1', 'flow:f1', null)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('clear() 之后必然重查 —— 权限撤销靠这一条把窗口压到 0，而不是等 TTL', async () => {
    const time = clock()
    const { authorize, calls } = stubAuthorize(['forbidden'])
    const gate = createWriteGate({ authorize, now: time.now, ttlMs: 10_000 })

    gate.prime('s1')
    expect(await gate.check('s1', 'flow:f1', null)).toBeNull()
    expect(calls).toHaveLength(0)

    // 有人被移出项目 → revalidateConnections 开头清表
    gate.clear()

    // TTL 一点都没走，但下一帧照样重查，并且这次被拒
    expect(await gate.check('s1', 'flow:f1', null)).toBe('forbidden')
    expect(calls).toHaveLength(1)
  })

  it('连接断了就把它的判定丢掉，不留着占内存', async () => {
    const { authorize } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    await gate.check('s1', 'flow:f1', null)
    expect(gate.size()).toBe(1)

    gate.forget('s1')
    expect(gate.size()).toBe(0)
  })

  it('丢掉的只是那一条 —— 别人的判定还在', async () => {
    const { authorize } = stubAuthorize(null)
    const gate = createWriteGate({ authorize })

    await gate.check('s1', 'flow:f1', null)
    await gate.check('s2', 'flow:f1', null)

    gate.forget('s1')
    expect(gate.size()).toBe(1)
  })
})

describe('鉴权本身出错', () => {
  it('查库抛异常 → 放行，下一帧再查 —— 没有证据不拒人', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const authorize: AuthorizeWrite = () => Promise.reject(new Error('数据库连不上'))
    const gate = createWriteGate({ authorize })

    expect(await gate.check('s1', 'flow:f1', null)).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('基础设施恢复之后判定跟着恢复 —— 故障期的放行不会被永久缓存', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const time = clock()
    let broken = true
    const authorize: AuthorizeWrite = () =>
      broken ? Promise.reject(new Error('数据库连不上')) : Promise.resolve('unauthorized')
    const gate = createWriteGate({ authorize, now: time.now, ttlMs: 10_000 })

    expect(await gate.check('s1', 'flow:f1', null)).toBeNull()

    broken = false
    time.advance(10_001)
    expect(await gate.check('s1', 'flow:f1', null)).toBe('unauthorized')
    warn.mockRestore()
  })
})
