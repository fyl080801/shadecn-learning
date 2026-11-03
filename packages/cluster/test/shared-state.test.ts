import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterBackend } from '../src/backend.js'
import { Bus, type BusEnvelope, defineRequest } from '../src/bus.js'
import { Cluster } from '../src/cluster.js'
import { createMemoryBackend } from '../src/memory.js'
import { createRedisBackend } from '../src/redis.js'
import { bytesCodec, jsonCodec, stringCodec } from '../src/shared-state.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

let round = 0
const unique = (name: string) => `test-${name}-${process.pid}-${Date.now()}-${round++}`

/** 同一套契约：`peer()` 是「另一个进程」。内存实现只有一个进程，所以是同一个 backend；Redis 是另一条连接 */
function contract(open: () => Promise<ClusterBackend>, peerOf: (backend: ClusterBackend) => Promise<ClusterBackend>) {
  let backend: ClusterBackend
  let peer: ClusterBackend

  beforeEach(async () => {
    backend = await open()
    peer = await peerOf(backend)
  })
  afterEach(async () => {
    await backend.close()
    await peer.close()
    vi.restoreAllMocks()
  })

  describe('SharedMap', () => {
    it('写进去读得出来，覆盖写以最后一次为准；没写过、删掉之后是 undefined', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      expect(await map.get('a')).toBeUndefined()
      await map.set('a', '一')
      await map.set('a', '二')
      expect(await map.get('a')).toBe('二')
      await map.delete('a')
      expect(await map.get('a')).toBeUndefined()
    })

    it('同名 namespace 跨实例是同一张表；不同 namespace 互不相干', async () => {
      const name = unique('m')
      await backend.createMap(name, stringCodec).set('k', 'v', 5000)
      expect(await peer.createMap(name, stringCodec).get('k')).toBe('v')
      expect(await backend.createMap(unique('m'), stringCodec).get('k')).toBeUndefined()
    })

    it('claim 先到先得：后来者拿不到，也改不掉已有的值', async () => {
      const name = unique('m')
      const map = backend.createMap(name, stringCodec)
      expect(await map.claim('7', 'socket-a', 5000)).toBe(true)
      expect(await peer.createMap(name, stringCodec).claim('7', 'socket-b', 5000)).toBe(false)
      expect(await map.get('7')).toBe('socket-a')
    })

    it('claim 不给 TTL 也能用', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      expect(await map.claim('k', 'a')).toBe(true)
      expect(await map.claim('k', 'b')).toBe(false)
      await map.delete('k')
    })

    it('TTL 到点消失；过期的 claim 能被接手', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('a', '一', 60)
      expect(await map.claim('b', 'old', 60)).toBe(true)
      expect(await map.get('a')).toBe('一')
      await sleep(120)
      expect(await map.get('a')).toBeUndefined()
      expect(await map.claim('b', 'new', 5000)).toBe(true)
      expect(await map.get('b')).toBe('new')
    })

    it('deleteIfEquals：值相等才删，旧持有者删不掉新主人的；键不存在返回 false', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('k', 'new-owner', 5000)
      expect(await map.deleteIfEquals('k', 'old-owner')).toBe(false)
      expect(await map.get('k')).toBe('new-owner')
      expect(await map.deleteIfEquals('k', 'new-owner')).toBe(true)
      expect(await map.get('k')).toBeUndefined()
      expect(await map.deleteIfEquals('k', 'new-owner')).toBe(false)
    })

    it('compareAndSet：值相等才写；值不同或键不存在返回 false，不写', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      expect(await map.compareAndSet('k', 'a', 'b', 5000)).toBe(false)
      expect(await map.get('k')).toBeUndefined()

      await map.set('k', 'run-1', 5000)
      expect(await map.compareAndSet('k', 'run-2', 'run-3', 5000)).toBe(false)
      expect(await map.get('k')).toBe('run-1')

      // 转交：持有者换成另一个
      expect(await map.compareAndSet('k', 'run-1', 'run-child', 5000)).toBe(true)
      expect(await map.get('k')).toBe('run-child')
    })

    it('compareAndSet 续期：重设 TTL，值不变；过期被别人占走后续不回来', async () => {
      const name = unique('m')
      const map = backend.createMap(name, stringCodec)
      expect(await map.claim('k', 'me', 300)).toBe(true)
      await sleep(200)
      expect(await map.compareAndSet('k', 'me', 'me', 600)).toBe(true)
      await sleep(250)
      // 原 TTL 早该到了，续期后还在
      expect(await map.get('k')).toBe('me')

      await sleep(450)
      expect(await map.get('k')).toBeUndefined()
      expect(await peer.createMap(name, stringCodec).claim('k', 'other', 5000)).toBe(true)
      expect(await map.compareAndSet('k', 'me', 'me', 5000)).toBe(false)
      expect(await map.get('k')).toBe('other')
    })

    it('compareAndSet 比较失败不动原来的 TTL', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('k', 'other', 200)
      expect(await map.compareAndSet('k', 'me', 'me', 5000)).toBe(false)
      await sleep(300)
      expect(await map.get('k')).toBeUndefined()
    })

    it('compareAndSet 不给 TTL：写成不过期，不沿用原来的 TTL', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('k', 'a', 150)
      expect(await map.compareAndSet('k', 'a', 'b')).toBe(true)
      await sleep(250)
      expect(await map.get('k')).toBe('b')
      await map.delete('k')
    })

    it('compareAndSet 对已经过期的键：当作不存在', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('k', 'me', 50)
      await sleep(120)
      expect(await map.compareAndSet('k', 'me', 'me', 5000)).toBe(false)
      expect(await map.get('k')).toBeUndefined()
    })

    it('compareAndSet 比的是编码后的值，对象不靠引用', async () => {
      const map = backend.createMap<{ run: string }>(unique('m'), jsonCodec())
      await map.set('k', { run: 'a' }, 5000)
      expect(await map.compareAndSet('k', { run: 'a' }, { run: 'b' }, 5000)).toBe(true)
      expect(await map.get('k')).toEqual({ run: 'b' })
    })

    it('并发的 compareAndSet 只有一个赢，值就是赢家写的（两个实例同时抢）', async () => {
      const name = unique('m')
      const ours = backend.createMap(name, stringCodec)
      const theirs = peer.createMap(name, stringCodec)
      await ours.set('k', 'start', 5000)
      const contenders = Array.from({ length: 40 }, (_, index) => `next-${index}`)
      const results = await Promise.all(contenders.map((next, index) => (index % 2 ? ours : theirs).compareAndSet('k', 'start', next, 5000)))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await ours.get('k')).toBe(contenders[results.indexOf(true)])
    })

    it('entries 按前缀列，键不带 namespace；过期的不算', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('room-1:a', '1', 5000)
      await map.set('room-1:b', '2', 5000)
      await map.set('room-2:c', '3', 5000)
      await map.set('room-1:gone', 'x', 30)
      await sleep(80)
      const listed = (await map.entries('room-1:')).sort(([a], [b]) => a.localeCompare(b))
      expect(listed).toEqual([['room-1:a', '1'], ['room-1:b', '2']])
      expect(await map.entries('nothing:')).toEqual([])
      expect((await map.entries()).length).toBe(3)
    })

    it('deleteByPrefix 只删这个前缀', async () => {
      const map = backend.createMap(unique('m'), stringCodec)
      await map.set('room-1:a', '1', 5000)
      await map.set('room-2:b', '2', 5000)
      await map.deleteByPrefix('room-1:')
      expect(await map.get('room-1:a')).toBeUndefined()
      expect(await map.get('room-2:b')).toBe('2')
      await map.deleteByPrefix('没有这个前缀:')
    })

    it('编解码：二进制原样还原；JSON 读出来是新对象，deleteIfEquals 比的是编码后的值', async () => {
      const bytes = backend.createMap(unique('m'), bytesCodec)
      await bytes.set('sv', new Uint8Array([0, 1, 254, 255]), 5000)
      expect(await bytes.get('sv')).toEqual(new Uint8Array([0, 1, 254, 255]))

      const json = backend.createMap<{ n: number }>(unique('m'), jsonCodec())
      const value = { n: 1 }
      await json.set('k', value, 5000)
      expect(await json.get('k')).toEqual(value)
      expect(await json.get('k')).not.toBe(value)
      expect(await json.deleteIfEquals('k', { n: 1 })).toBe(true)
    })
  })

  describe('SharedChannel', () => {
    const inbox = <V>() => {
      const got: V[] = []
      return { got, handler: (message: V) => void got.push(message) }
    }

    it('消息到达这个频道此刻的全部订阅者（含别的实例）；发送方自己也算', async () => {
      const name = unique('c')
      const one = inbox<{ n: number }>()
      const two = inbox<{ n: number }>()
      const sender = backend.createChannel<{ n: number }>(name, jsonCodec())
      const off1 = await sender.subscribe('x', one.handler)
      const off2 = await peer.createChannel<{ n: number }>(name, jsonCodec()).subscribe('x', two.handler)
      await sender.publish('x', { n: 1 })
      await vi.waitFor(() => {
        expect(one.got).toEqual([{ n: 1 }])
        expect(two.got).toEqual([{ n: 1 }])
      })
      await off1()
      await off2()
    })

    it('别的频道、别的 namespace 收不到', async () => {
      const name = unique('c')
      const box = inbox<string>()
      const channel = backend.createChannel(name, stringCodec)
      const off = await channel.subscribe('a', box.handler)
      await channel.publish('b', 'x')
      await backend.createChannel(unique('c'), stringCodec).publish('a', 'y')
      await sleep(80)
      expect(box.got).toEqual([])
      await off()
    })

    it('订阅之前发的收不到，退订之后不再收，退订只影响自己', async () => {
      const channel = backend.createChannel(unique('c'), stringCodec)
      await channel.publish('a', '太早了')
      await sleep(30)
      const first = inbox<string>()
      const second = inbox<string>()
      const offFirst = await channel.subscribe('a', first.handler)
      const offSecond = await channel.subscribe('a', second.handler)
      await channel.publish('a', '一')
      await vi.waitFor(() => expect(first.got).toEqual(['一']))
      await offFirst()
      await channel.publish('a', '二')
      await vi.waitFor(() => expect(second.got).toEqual(['一', '二']))
      expect(first.got).toEqual(['一'])
      await offSecond()
    })

    it('一个订阅者抛错不影响别的', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const channel = backend.createChannel(unique('c'), stringCodec)
      const box = inbox<string>()
      const offBad = await channel.subscribe('a', () => {
        throw new Error('坏订阅者')
      })
      const offGood = await channel.subscribe('a', box.handler)
      await channel.publish('a', 'x')
      await vi.waitFor(() => expect(box.got).toEqual(['x']))
      await offBad()
      await offGood()
    })
  })

  describe('Bus', () => {
    const channelName = () => unique('bus')
    const buses: Bus[] = []
    const makeBus = (of: ClusterBackend, namespace: string, id: string, ttl?: number) => {
      const bus = new Bus(id, of.createChannel<BusEnvelope>(namespace, jsonCodec()), of.createMap(`${namespace}-responder`, stringCodec), ttl)
      buses.push(bus)
      return bus
    }
    const ECHO = defineRequest<{ n: number }, { doubled: number; by: string }>('test.echo')

    afterEach(async () => {
      for (const bus of buses.splice(0)) await bus.close()
    })

    it('没有提供方：立刻返回空结果，不等超时', async () => {
      const started = Date.now()
      const result = await makeBus(backend, channelName(), 'a').request(ECHO, { n: 1 }, { timeoutMs: 5000 })
      expect(result).toEqual({ replies: [], failures: [], missing: [] })
      expect(Date.now() - started).toBeLessThan(1000)
    })

    it('本实例直接调，别的实例经共享层回话，全部到齐就返回；没登记处理函数的实例也能发', async () => {
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      const b = makeBus(peer, name, 'b')
      const caller = makeBus(backend, name, 'caller')
      await a.handle(ECHO, ({ n }) => ({ doubled: n * 2, by: 'a' }))
      await b.handle(ECHO, ({ n }) => Promise.resolve({ doubled: n * 2, by: 'b' }))

      const started = Date.now()
      const fromA = await a.request(ECHO, { n: 21 }, { timeoutMs: 5000 })
      expect(fromA.missing).toEqual([])
      expect(fromA.replies.map((reply) => reply.instance).sort()).toEqual(['a', 'b'])
      expect(fromA.replies.every((reply) => reply.value.doubled === 42)).toBe(true)

      const fromCaller = await caller.request(ECHO, { n: 1 }, { timeoutMs: 5000 })
      expect(fromCaller.replies.map((reply) => reply.instance).sort()).toEqual(['a', 'b'])
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('处理函数抛错：记在 failures，不影响别的实例', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      const b = makeBus(peer, name, 'b')
      await a.handle(ECHO, ({ n }) => ({ doubled: n, by: 'a' }))
      await b.handle(ECHO, () => {
        throw new Error('落库失败')
      })
      const result = await a.request(ECHO, { n: 1 }, { timeoutMs: 5000 })
      expect(result.replies.map((reply) => reply.instance)).toEqual(['a'])
      expect(result.failures).toEqual([{ instance: 'b', error: '落库失败' }])
      expect(result.missing).toEqual([])
    })

    it('处理函数卡住：到超时后列进 missing，回来的照收，不抛错', async () => {
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      const b = makeBus(peer, name, 'b')
      const c = makeBus(peer, name, 'c')
      await b.handle(ECHO, () => ({ doubled: 0, by: 'b' }))
      await c.handle(ECHO, () => new Promise<never>(() => undefined))
      const result = await a.request(ECHO, { n: 1 }, { timeoutMs: 150 })
      expect(result.replies.map((reply) => reply.instance)).toEqual(['b'])
      expect(result.missing).toEqual(['c'])
    })

    it('撤销处理函数等于撤掉登记：之后不再等它；撤销后可以重新注册', async () => {
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      const b = makeBus(peer, name, 'b')
      const off = await b.handle(ECHO, () => ({ doubled: 0, by: 'b' }))
      await off()
      const started = Date.now()
      expect(await a.request(ECHO, { n: 1 }, { timeoutMs: 5000 })).toEqual({ replies: [], failures: [], missing: [] })
      expect(Date.now() - started).toBeLessThan(1000)
      await b.handle(ECHO, () => ({ doubled: 0, by: 'b2' }))
    })

    it('同一个令牌在一个实例上只能有一个处理函数', async () => {
      const a = makeBus(backend, channelName(), 'a')
      await a.handle(ECHO, () => ({ doubled: 0, by: 'a' }))
      await expect(a.handle(ECHO, () => ({ doubled: 0, by: 'a' }))).rejects.toThrow('已经有处理函数')
    })

    it('实例崩溃留下的登记：TTL 内算 missing，过了 TTL 不再等', async () => {
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      await backend.createMap(`${name}-responder`, stringCodec).set(`${ECHO.name}:ghost`, 'ghost', 150)
      expect((await a.request(ECHO, { n: 1 }, { timeoutMs: 50 })).missing).toEqual(['ghost'])
      await sleep(200)
      expect((await a.request(ECHO, { n: 1 }, { timeoutMs: 5000 })).missing).toEqual([])
    })

    it('close：撤掉登记，等待中的请求立刻收尾', async () => {
      const name = channelName()
      const a = makeBus(backend, name, 'a')
      const b = makeBus(peer, name, 'b')
      await b.handle(ECHO, () => new Promise<never>(() => undefined))
      const pending = a.request(ECHO, { n: 1 }, { timeoutMs: 30_000 })
      await sleep(50)
      await a.close()
      expect((await pending).missing).toEqual(['b'])
      await b.close()
      expect(await backend.createMap(`${name}-responder`, stringCodec).entries()).toEqual([])
    })
  })
}

describe('共享结构契约（内存）', () => {
  contract(
    () => Promise.resolve(createMemoryBackend()),
    (backend) => Promise.resolve({ ...backend, close: () => Promise.resolve() }),
  )
})

describe.skipIf(!redisUrl)('共享结构契约（Redis，PLATFORM_TEST_REDIS_URL）', () => {
  contract(
    () => createRedisBackend(redisUrl as string),
    () => createRedisBackend(redisUrl as string),
  )
})

describe.skipIf(!redisUrl)('共享结构的 Redis 专属语义', () => {
  const admin = new Redis(redisUrl as string)
  afterAll(() => {
    admin.disconnect()
  })
  const pubsubClients = async () => ((await admin.call('CLIENT', 'LIST', 'TYPE', 'pubsub')) as string).split('\n').filter(Boolean).length

  it('compareAndSet 的 TTL 落在键上：给了是 PX，不给就清掉', async () => {
    const backend = await createRedisBackend(redisUrl as string)
    const name = unique('m')
    const map = backend.createMap(name, stringCodec)
    await map.set('k', 'a', 60_000)
    expect(await map.compareAndSet('k', 'a', 'b', 5000)).toBe(true)
    const ttl = await admin.pttl(`learning:${name}:k`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(5000)
    expect(await map.compareAndSet('k', 'b', 'c')).toBe(true)
    expect(await admin.pttl(`learning:${name}:k`)).toBe(-1)
    await map.delete('k')
    await backend.close()
  })

  it('compareAndSet 连接断了：reject，不是回 false（false 的意思是「被别人占了」）', async () => {
    const backend = await createRedisBackend(redisUrl as string)
    const map = backend.createMap(unique('m'), stringCodec)
    await backend.close()
    await expect(map.compareAndSet('k', 'a', 'b', 1000)).rejects.toThrow()
  })

  it('订阅连接断了：ioredis 重连后自动重新订阅，消息又收得到（断开期间的丢失）', async () => {
    const backend = await createRedisBackend(redisUrl as string)
    const channel = backend.createChannel(unique('c'), stringCodec)
    const got: string[] = []
    const off = await channel.subscribe('a', (message) => void got.push(message))

    await admin.call('CLIENT', 'KILL', 'TYPE', 'pubsub')
    await vi.waitFor(async () => {
      await channel.publish('a', 'x')
      expect(got).toContain('x')
    }, { timeout: 5000, interval: 100 })
    await off()
    await backend.close()
  })

  it('关闭时订阅连接也关：退出后 Redis 上不留 pubsub 连接；health 关后不 ok', async () => {
    const before = await pubsubClients()
    const backend = await createRedisBackend(redisUrl as string)
    await backend.createChannel(unique('c'), stringCodec).subscribe('a', () => undefined)
    expect(await pubsubClients()).toBe(before + 1)
    expect(backend.health()).toEqual({ ok: true, backend: 'redis', status: 'ready' })

    await backend.close()
    await vi.waitFor(async () => expect(await pubsubClients()).toBe(before))
    expect(backend.health().ok).toBe(false)
  })

  it('没订阅过时不建订阅连接', async () => {
    const before = await pubsubClients()
    const backend = await createRedisBackend(redisUrl as string)
    await backend.createMap(unique('m'), stringCodec).set('k', 'v', 100)
    expect(await pubsubClients()).toBe(before)
    await backend.close()
  })

  it('连接断了：Map 的方法 reject（fail-open 归调用方），总线不抛错，只问本实例', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const backend = await createRedisBackend(redisUrl as string)
    const map = backend.createMap(unique('m'), stringCodec)
    const bus = new Bus('solo', backend.createChannel<BusEnvelope>(unique('bus'), jsonCodec()), backend.createMap(unique('bus-responder'), stringCodec))
    const TOKEN = defineRequest<null, string>('test.solo')
    await bus.handle(TOKEN, () => 'local')
    await backend.close()

    await expect(map.get('k')).rejects.toThrow()
    const result = await bus.request(TOKEN, null, { timeoutMs: 200 })
    expect(result.replies).toEqual([{ instance: 'solo', value: 'local' }])
    expect(result.missing).toEqual([])
    warn.mockRestore()
    await bus.close()
  })
})

describe('Cluster', () => {
  it('instanceId：主机名 + 随机后缀，两个实例不撞；可以指定', () => {
    const a = new Cluster('single', createMemoryBackend())
    const b = new Cluster('single', createMemoryBackend())
    expect(a.instanceId).not.toBe(b.instanceId)
    expect(a.bus.instanceId).toBe(a.instanceId)
    expect(new Cluster('single', createMemoryBackend(), 'fixed').instanceId).toBe('fixed')
  })

  it('single 的 health 恒 ok，createMap / createLog / createChannel / bus 都可用；关闭只关一次，先撤总线', async () => {
    const backend = createMemoryBackend()
    const close = vi.spyOn(backend, 'close')
    const cluster = new Cluster('single', backend, 'me')
    expect(cluster.health()).toEqual({ ok: true, backend: 'memory', status: 'ready' })

    const TOKEN = defineRequest<null, string>('test.cluster')
    await cluster.bus.handle(TOKEN, () => 'pong')
    expect((await cluster.bus.request(TOKEN, null)).replies).toEqual([{ instance: 'me', value: 'pong' }])
    await cluster.createMap('m', stringCodec).set('k', 'v')
    expect(await cluster.createMap('m', stringCodec).get('k')).toBe('v')
    await cluster.createLog('g', stringCodec).append('k', 'v')
    expect((await cluster.createLog('g', stringCodec).read('k', null)).map((entry) => entry.value)).toEqual(['v'])

    await cluster.onApplicationShutdown()
    await cluster.onApplicationShutdown()
    expect(close).toHaveBeenCalledTimes(1)
    expect((await cluster.bus.request(TOKEN, null)).replies).toEqual([])
  })
})
