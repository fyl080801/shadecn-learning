import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus, defineRequest, type Bus } from '../src/bus.ts'
import { createMemoryBackend } from '../src/cluster/memory.ts'
import { jsonCodec, stringCodec, type ClusterBackend, type SharedMap } from '../src/cluster/shared.ts'

/**
 * 总线的 scatter-gather：一个内存后端上建几个总线 = 几个实例（和共享层契约测试同一个路数，不用真起进程）。
 */

const ECHO = defineRequest<{ n: number }, { doubled: number; by: string }>('test.echo')

/**
 * 内存后端的 `createMap` 每次都是一张新表（只有 log 和频道按命名空间共享），所以模拟多个实例时
 * 登记表要按后端共用一张 —— 对应 Redis 下大家读写同一个键空间
 */
const registries = new WeakMap<ClusterBackend, SharedMap<string>>()
function respondersOf(backend: ClusterBackend): SharedMap<string> {
  let map = registries.get(backend)
  if (!map) registries.set(backend, (map = backend.createMap('bus-responder', stringCodec)))
  return map
}

const buses: Bus[] = []

function instance(backend: ClusterBackend, id: string, ttl = 30_000): Bus {
  const bus = createBus({
    instanceId: id,
    channel: backend.createChannel('bus', jsonCodec()),
    responders: respondersOf(backend),
    responderTtlMs: ttl,
  })
  buses.push(bus)
  return bus
}

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('总线：scatter-gather 请求', () => {
  it('没有任何提供方 → 立刻返回空结果，不等超时', async () => {
    const backend = createMemoryBackend()
    const caller = instance(backend, 'a')

    const started = Date.now()
    const result = await caller.request(ECHO, { n: 1 }, { timeoutMs: 5_000 })

    expect(result).toEqual({ replies: [], failures: [], missing: [] })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('本实例的处理函数直接调用；别的实例经共享层回话；全部到齐就返回', async () => {
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    const b = instance(backend, 'b')
    const c = instance(backend, 'c')
    await a.handle(ECHO, ({ n }) => ({ doubled: n * 2, by: 'a' }))
    await b.handle(ECHO, async ({ n }) => ({ doubled: n * 2, by: 'b' }))
    await c.handle(ECHO, ({ n }) => ({ doubled: n * 2, by: 'c' }))

    const result = await a.request(ECHO, { n: 21 })

    expect(result.missing).toEqual([])
    expect(result.failures).toEqual([])
    expect(result.replies.map((reply) => reply.instance).sort()).toEqual(['a', 'b', 'c'])
    expect(result.replies.every((reply) => reply.value.doubled === 42)).toBe(true)
  })

  it('没登记处理函数的实例也能发请求', async () => {
    const backend = createMemoryBackend()
    const caller = instance(backend, 'web')
    const collab = instance(backend, 'collab')
    await collab.handle(ECHO, ({ n }) => ({ doubled: n * 2, by: 'collab' }))

    const result = await caller.request(ECHO, { n: 2 })

    expect(result.replies).toEqual([{ instance: 'collab', value: { doubled: 4, by: 'collab' } }])
  })

  it('处理函数抛错 → 那个实例记在 failures，不影响别的实例', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    const b = instance(backend, 'b')
    await a.handle(ECHO, ({ n }) => ({ doubled: n * 2, by: 'a' }))
    await b.handle(ECHO, () => {
      throw new Error('落库失败')
    })

    const result = await a.request(ECHO, { n: 1 })

    expect(result.replies).toEqual([{ instance: 'a', value: { doubled: 2, by: 'a' } }])
    expect(result.failures).toEqual([{ instance: 'b', error: '落库失败' }])
    expect(result.missing).toEqual([])
  })

  it('登记了却不回话的实例（处理函数卡住）→ 到超时后列进 missing，回来的照收', async () => {
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    const b = instance(backend, 'b')
    const c = instance(backend, 'c')
    await b.handle(ECHO, () => ({ doubled: 0, by: 'b' }))
    await c.handle(ECHO, () => new Promise<never>(() => {}))

    const result = await a.request(ECHO, { n: 1 }, { timeoutMs: 100 })

    expect(result.replies.map((reply) => reply.instance)).toEqual(['b'])
    expect(result.missing).toEqual(['c'])
  })

  it('撤销处理函数 = 撤掉登记：之后的请求不再等它', async () => {
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    const b = instance(backend, 'b')
    const off = await b.handle(ECHO, () => ({ doubled: 0, by: 'b' }))
    await off()

    const result = await a.request(ECHO, { n: 1 }, { timeoutMs: 5_000 })

    expect(result).toEqual({ replies: [], failures: [], missing: [] })
  })

  it('同一个令牌在一个实例上只能有一个处理函数', async () => {
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    await a.handle(ECHO, () => ({ doubled: 0, by: 'a' }))
    await expect(a.handle(ECHO, () => ({ doubled: 0, by: 'a' }))).rejects.toThrow(/已经有处理函数/)
  })

  it('实例崩溃留下的登记过了 TTL 就不再被等', async () => {
    vi.useFakeTimers()
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    // 崩溃的实例：直接往登记表里写一条，没有任何订阅者会回话，也不会续期
    await respondersOf(backend).set('test.echo:ghost', 'ghost', 1_000)

    const pending = a.request(ECHO, { n: 1 }, { timeoutMs: 200 })
    await vi.advanceTimersByTimeAsync(200)
    expect((await pending).missing).toEqual(['ghost'])

    await vi.advanceTimersByTimeAsync(1_000)
    const later = await a.request(ECHO, { n: 1 }, { timeoutMs: 200 })
    expect(later.missing).toEqual([])
  })
})

describe('总线：dispatch 派给一个提供方', () => {
  it('没有提供方 → no-responder，立刻返回', async () => {
    const result = await instance(createMemoryBackend(), 'web').dispatch(ECHO, { n: 1 }, { timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reason: 'no-responder' })
  })

  it('本实例登记了就交给本实例，不碰别的实例', async () => {
    const backend = createMemoryBackend()
    const a = instance(backend, 'a')
    const b = instance(backend, 'b')
    const seen: string[] = []
    await a.handle(ECHO, ({ n }) => (seen.push('a'), { doubled: n * 2, by: 'a' }))
    await b.handle(ECHO, ({ n }) => (seen.push('b'), { doubled: n * 2, by: 'b' }))

    const result = await a.dispatch(ECHO, { n: 3 })

    expect(result).toEqual({ ok: true, instance: 'a', value: { doubled: 6, by: 'a' } })
    expect(seen).toEqual(['a'])
  })

  it('派给别的实例：只有一个实例处理', async () => {
    const backend = createMemoryBackend()
    const web = instance(backend, 'web')
    const seen: string[] = []
    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      await instance(backend, id).handle(ECHO, ({ n }) => (seen.push(id), { doubled: n * 2, by: id }))
    }

    const result = await web.dispatch(ECHO, { n: 1 })

    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(result.ok && result.instance).toBe(seen[0])
  })

  it('选中的实例超时 → timeout，且不换实例重发', async () => {
    const backend = createMemoryBackend()
    const web = instance(backend, 'web')
    let calls = 0
    await instance(backend, 'agent-1').handle(ECHO, () => {
      calls += 1
      return new Promise<never>(() => {})
    })

    const result = await web.dispatch(ECHO, { n: 1 }, { timeoutMs: 100 })

    expect(result).toEqual({ ok: false, reason: 'timeout', instance: 'agent-1' })
    expect(calls).toBe(1)
  })

  it('处理函数抛错 → failed，带上原因', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend = createMemoryBackend()
    const web = instance(backend, 'web')
    await instance(backend, 'agent-1').handle(ECHO, () => {
      throw new Error('沙箱起不来')
    })

    expect(await web.dispatch(ECHO, { n: 1 })).toEqual({ ok: false, reason: 'failed', instance: 'agent-1', error: '沙箱起不来' })
  })
})
