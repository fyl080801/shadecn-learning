import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryBackend } from '../../cluster/memory.ts'
import { jsonCodec, numberCodec, stringCodec, type ClusterBackend } from '../../cluster/shared.ts'

/**
 * 共享状态抽象的**契约**：同一组用例，两套实现各跑一遍。
 *
 * 内存实现永远跑；Redis 实现只有设了 `TEST_REDIS_URL` 才跑
 * （和 `TEST_DATABASE_URL` 一样的路数 —— 本地起个容器就能验，CI 不强制）。
 * 两边跑的是同一份断言，这正是「换实现不用改调用方」的证据。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Candidate {
  name: string
  create: () => Promise<ClusterBackend>
}

const candidates: Candidate[] = [
  { name: '内存实现', create: () => Promise.resolve(createMemoryBackend()) },
]

const redisUrl = process.env.TEST_REDIS_URL?.trim()
if (redisUrl) {
  candidates.push({
    name: 'Redis 实现',
    create: async () => {
      const { createRedisBackend } = await import('../../cluster/redis.ts')
      // 每轮一个随机前缀：跑完不用收拾，也不会和别的测试/真实数据撞键
      return createRedisBackend({ url: redisUrl, prefix: `test-${randomUUID().slice(0, 8)}` })
    },
  })
}

for (const candidate of candidates) {
  describe(candidate.name, () => {
    let backend: ClusterBackend

    // 整组共用一个 backend（Redis 那边就是一条连接）；用例之间靠不同的
    // namespace 隔离，而不是靠各建各的
    beforeAll(async () => {
      backend = await candidate.create()
    })

    afterAll(async () => {
      // 跑在真 Redis 上时把这轮的键收掉，别在人家库里留一地垃圾
      await backend?.clearAll?.()
      await backend?.close()
    })

    /**
     * 健康读数。两套实现都要给得出，而且**必须是同步的、不发网络请求** ——
     * 它服务于健康检查（`GET /api/collab/health`），而健康检查不能因为
     * 依赖慢就跟着卡住：那会把「Redis 慢」变成「健康检查超时」，两件事的处置完全不同。
     */
    describe('health', () => {
      it('连着的时候报 ok，并说明自己是哪种后端', () => {
        const health = backend.health()
        expect(health.ok).toBe(true)
        expect(['memory', 'redis']).toContain(health.backend)
        expect(health.status).toBeTruthy()
      })

      it('是同步返回，不是 Promise', () => {
        // 返回 Promise 的话，探针就得 await 一个可能永远不回来的东西
        expect(backend.health()).not.toBeInstanceOf(Promise)
      })
    })

    describe('SharedMap', () => {
      it('写进去读得出来，覆盖写以最后一次为准', async () => {
        const map = backend.createMap('m1', stringCodec)
        await map.set('a', '一')
        expect(await map.get('a')).toBe('一')

        await map.set('a', '二')
        expect(await map.get('a')).toBe('二')
      })

      it('没写过的键读出来是 undefined，删掉之后也是', async () => {
        const map = backend.createMap('m2', stringCodec)
        expect(await map.get('никого')).toBeUndefined()

        await map.set('a', '一')
        await map.delete('a')
        expect(await map.get('a')).toBeUndefined()
      })

      it('claim 是先到先得 —— 后来者拿不到，也改不掉已有的值', async () => {
        const map = backend.createMap('m3', stringCodec)

        expect(await map.claim('7', 'socket-a')).toBe(true)
        expect(await map.claim('7', 'socket-b')).toBe(false)
        // 关键：抢输的那次不能把值改掉，否则冒名者一次重试就顶掉了正主
        expect(await map.get('7')).toBe('socket-a')
      })

      it('TTL 到点自动消失', async () => {
        const map = backend.createMap('m4', stringCodec)
        await map.set('a', '一', 60)
        expect(await map.get('a')).toBe('一')

        await sleep(120)
        expect(await map.get('a')).toBeUndefined()
      })

      it('过期的 claim 可以被后来者接手', async () => {
        const map = backend.createMap('m5', stringCodec)
        expect(await map.claim('7', 'socket-old', 60)).toBe(true)

        await sleep(120)
        expect(await map.claim('7', 'socket-new', 60)).toBe(true)
        expect(await map.get('7')).toBe('socket-new')
      })

      it('compareAndSet：值相等才写，续期不改值，不相等或键不存在返回 false', async () => {
        const map = backend.createMap('m9', stringCodec)
        expect(await map.compareAndSet('k', 'a', 'b')).toBe(false)
        expect(await map.get('k')).toBeUndefined()

        await map.set('k', 'run-1')
        expect(await map.compareAndSet('k', 'run-2', 'run-3')).toBe(false)
        expect(await map.get('k')).toBe('run-1')

        // 转交：持有者换成另一个（同一轮里调用方 → 被调用的 agent）
        expect(await map.compareAndSet('k', 'run-1', 'run-child')).toBe(true)
        expect(await map.get('k')).toBe('run-child')
      })

      it('compareAndSet 续期：重设 TTL，值不变；过期被别人 claim 走后续不回来', async () => {
        const map = backend.createMap('m10', stringCodec)
        expect(await map.claim('k', 'me', 80)).toBe(true)
        await sleep(50)
        expect(await map.compareAndSet('k', 'me', 'me', 150)).toBe(true)
        await sleep(60)
        // 原 TTL 早该到了，续期后还在
        expect(await map.get('k')).toBe('me')

        await sleep(150)
        expect(await map.get('k')).toBeUndefined()
        expect(await map.claim('k', 'other', 1000)).toBe(true)
        expect(await map.compareAndSet('k', 'me', 'me', 1000)).toBe(false)
        expect(await map.get('k')).toBe('other')
      })

      it('compareAndSet 比的是编码后的值（对象不靠引用）', async () => {
        const map = backend.createMap<{ run: string }>('m11', jsonCodec())
        await map.set('k', { run: 'a' })
        expect(await map.compareAndSet('k', { run: 'a' }, { run: 'b' })).toBe(true)
        expect(await map.get('k')).toEqual({ run: 'b' })
      })

      it('deleteIfEquals：只删自己的，别人的（含过期后易主的）删不掉', async () => {
        const map = backend.createMap('m12', stringCodec)
        expect(await map.deleteIfEquals('k', 'me')).toBe(false)

        await map.set('k', 'other')
        expect(await map.deleteIfEquals('k', 'me')).toBe(false)
        expect(await map.get('k')).toBe('other')

        expect(await map.deleteIfEquals('k', 'other')).toBe(true)
        expect(await map.get('k')).toBeUndefined()
      })

      it('entries 按前缀筛，deleteByPrefix 只删这一片', async () => {
        const map = backend.createMap('m6', stringCodec)
        await map.set('room-a:1', 'x')
        await map.set('room-a:2', 'y')
        await map.set('room-b:1', 'z')

        const roomA = await map.entries('room-a:')
        expect(roomA.map(([key]) => key).sort()).toEqual(['room-a:1', 'room-a:2'])

        await map.deleteByPrefix('room-a:')
        expect(await map.entries('room-a:')).toHaveLength(0)
        expect(await map.get('room-b:1')).toBe('z')
      })

      it('不同 namespace 的同名键互不干扰', async () => {
        const one = backend.createMap('ns-one', stringCodec)
        const two = backend.createMap('ns-two', stringCodec)

        await one.set('k', '一')
        await two.set('k', '二')

        expect(await one.get('k')).toBe('一')
        expect(await two.get('k')).toBe('二')
      })

      it('对象和二进制都能原样存取（codec 的活）', async () => {
        const objects = backend.createMap<{ x: number; label: string }>('m7', jsonCodec())
        await objects.set('a', { x: 1, label: '节点' })
        expect(await objects.get('a')).toEqual({ x: 1, label: '节点' })

        const numbers = backend.createMap('m8', numberCodec)
        await numbers.set('a', 42)
        expect(await numbers.get('a')).toBe(42)
      })
    })

    describe('SharedCounter', () => {
      it('第一次用 seed 播种，发出去的第一个号是它 +1', async () => {
        const counter = backend.createCounter('c1')
        expect(await counter.next('flow-1', () => Promise.resolve(7))).toBe(8)
      })

      it('之后不再播种，一路递增', async () => {
        const counter = backend.createCounter('c2')
        let seeds = 0
        const seed = () => {
          seeds += 1
          return Promise.resolve(0)
        }

        expect(await counter.next('flow-1', seed)).toBe(1)
        expect(await counter.next('flow-1', seed)).toBe(2)
        expect(await counter.next('flow-1', seed)).toBe(3)
        expect(seeds).toBe(1)
      })

      it('并发取号不会重号 —— 这正是审计 seq 撞唯一键的那个场景', async () => {
        const counter = backend.createCounter('c3')
        const seq = await Promise.all(
          Array.from({ length: 20 }, () => counter.next('flow-1', () => Promise.resolve(0))),
        )
        expect(new Set(seq).size).toBe(20)
      })

      it('不同的键各算各的', async () => {
        const counter = backend.createCounter('c4')
        expect(await counter.next('flow-a', () => Promise.resolve(100))).toBe(101)
        expect(await counter.next('flow-b', () => Promise.resolve(0))).toBe(1)
      })

      it('forget 之后重新播种 —— 缓存没了也能从库里对齐回来', async () => {
        const counter = backend.createCounter('c5')
        expect(await counter.next('flow-1', () => Promise.resolve(0))).toBe(1)

        await counter.forget('flow-1')
        // 播种值模拟「库里已经写到 9 号了」，接着发必须是 10，不能退回 2
        expect(await counter.next('flow-1', () => Promise.resolve(9))).toBe(10)
      })
    })

    describe('SharedLock', () => {
      it('拿到锁就执行，结果原样返回', async () => {
        const lock = backend.createLock('l1')
        const result = await lock.run('k', () => Promise.resolve('做完了'), {
          fallback: () => Promise.resolve('没轮到我'),
        })
        expect(result).toBe('做完了')
      })

      it('同一个键同时进来两个，任务只跑一次', async () => {
        const lock = backend.createLock('l2')
        let runs = 0
        const task = async () => {
          runs += 1
          await sleep(30)
          return '赢家'
        }

        const [first, second] = await Promise.all([
          lock.run('k', task, { fallback: () => Promise.resolve('重读的结果'), ttlMs: 1000 }),
          lock.run('k', task, { fallback: () => Promise.resolve('重读的结果'), ttlMs: 1000 }),
        ])

        expect(runs).toBe(1)
        // 两种实现给后来者的答案不同（进程内复用同一个 promise，Redis 走 fallback），
        // 但共同的契约是：任务只跑一次，且后来者拿得到一个能用的结果
        expect([first, second]).toContain('赢家')
        expect(first).toBeDefined()
        expect(second).toBeDefined()
      })

      it('不同的键互不阻塞', async () => {
        const lock = backend.createLock('l3')
        const [a, b] = await Promise.all([
          lock.run('k1', () => Promise.resolve('a'), { fallback: () => Promise.resolve('x') }),
          lock.run('k2', () => Promise.resolve('b'), { fallback: () => Promise.resolve('x') }),
        ])
        expect([a, b]).toEqual(['a', 'b'])
      })

      it('任务抛异常也要把锁放掉，否则这个键就永远锁死了', async () => {
        const lock = backend.createLock('l4')
        await expect(
          lock.run('k', () => Promise.reject(new Error('炸了')), {
            fallback: () => Promise.resolve('x'),
          }),
        ).rejects.toThrow('炸了')

        const after = await lock.run('k', () => Promise.resolve('还能拿到锁'), {
          fallback: () => Promise.resolve('没拿到'),
        })
        expect(after).toBe('还能拿到锁')
      })
    })

    describe('SharedLog', () => {
      it('按追加的顺序读出来；从某一条之后接着读不漏不重', async () => {
        const log = backend.createLog<{ n: number }>('g1', jsonCodec())
        const ids: string[] = []
        for (let n = 1; n <= 4; n += 1) ids.push(await log.append('k', { n }))
        expect((await log.read('k', null)).map((entry) => entry.value.n)).toEqual([1, 2, 3, 4])
        expect((await log.read('k', ids[1]!)).map((entry) => entry.value.n)).toEqual([3, 4])
        expect((await log.read('k', ids[3]!))).toEqual([])
        expect((await log.read('k', null, 2)).map((entry) => entry.value.n)).toEqual([1, 2])
        // id 是追加时返回的那个，读出来的一致
        expect((await log.read('k', null)).map((entry) => entry.id)).toEqual(ids)
      })

      it('没写过的日志读出来是空的；不同的键、不同的 namespace 互不干扰', async () => {
        const a = backend.createLog('g2', stringCodec)
        const b = backend.createLog('g2b', stringCodec)
        expect(await a.read('nope', null)).toEqual([])
        await a.append('k1', 'a1')
        await a.append('k2', 'a2')
        await b.append('k1', 'b1')
        expect((await a.read('k1', null)).map((entry) => entry.value)).toEqual(['a1'])
        expect((await b.read('k1', null)).map((entry) => entry.value)).toEqual(['b1'])
      })

      it('同一个 backend 上各 createLog 一次也是同一份（两个「副本」读写同一个键）', async () => {
        const writer = backend.createLog('g3', stringCodec)
        const reader = backend.createLog('g3', stringCodec)
        await writer.append('k', 'x')
        expect((await reader.read('k', null)).map((entry) => entry.value)).toEqual(['x'])
      })

      it('maxLen 只留最近的那么多条，从最老的删起', async () => {
        const log = backend.createLog('g4', numberCodec)
        for (let n = 1; n <= 5; n += 1) await log.append('k', n, { maxLen: 3 })
        expect((await log.read('k', null)).map((entry) => entry.value)).toEqual([3, 4, 5])
      })

      it('wait：已经有就立刻返回，没有就等到新条目', async () => {
        const log = backend.createLog('g5', stringCodec)
        const first = await log.append('k', 'a')
        expect((await log.wait('k', null, 1000)).map((entry) => entry.value)).toEqual(['a'])

        const started = Date.now()
        const waiting = log.wait('k', first, 2000)
        await sleep(50)
        await log.append('k', 'b')
        const got = await waiting
        expect(got.map((entry) => entry.value)).toEqual(['b'])
        expect(Date.now() - started).toBeLessThan(1500)
      })

      it('wait：日志还不存在时也等，写出第一条就醒', async () => {
        const log = backend.createLog('g6', stringCodec)
        const waiting = log.wait('k', null, 2000)
        await sleep(50)
        await log.append('k', '第一条')
        expect((await waiting).map((entry) => entry.value)).toEqual(['第一条'])
      })

      it('wait：到点没有新条目返回空数组', async () => {
        const log = backend.createLog('g7', stringCodec)
        const last = await log.append('k', 'a')
        const started = Date.now()
        expect(await log.wait('k', last, 120)).toEqual([])
        expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      })

      it('同时等的多个读者都能醒', async () => {
        const log = backend.createLog('g8', stringCodec)
        const waits = [log.wait('k', null, 2000), log.wait('k', null, 2000), log.wait('k', null, 2000)]
        await sleep(50)
        await log.append('k', 'x')
        for (const got of await Promise.all(waits)) expect(got.map((entry) => entry.value)).toEqual(['x'])
      })

      it('TTL：整份日志到点消失；expire 续上就还在，日志不存在时 expire 返回 false', async () => {
        const log = backend.createLog('g9', stringCodec)
        await log.append('k', 'a', { ttlMs: 150 })
        await sleep(90)
        expect(await log.expire('k', 150)).toBe(true)
        await sleep(90)
        // 续过了：从续期那一刻再算 150ms
        expect((await log.read('k', null)).map((entry) => entry.value)).toEqual(['a'])
        await sleep(120)
        expect(await log.read('k', null)).toEqual([])
        expect(await log.expire('k', 150)).toBe(false)
      })

      it('delete 之后读不到；之后再追加，新条目的 id 排在旧游标之后', async () => {
        const log = backend.createLog('g10', stringCodec)
        const old = await log.append('k', 'a')
        await log.delete('k')
        expect(await log.read('k', null)).toEqual([])
        await log.append('k', 'b')
        expect((await log.read('k', old)).map((entry) => entry.value)).toEqual(['b'])
      })
    })

    describe('SharedChannel', () => {
      const received = <V>() => {
        const got: V[] = []
        return { got, handler: (message: V) => got.push(message) }
      }

      it('发出去的消息到达这个频道此刻的全部订阅者（含同一个 backend 上另建的频道对象）', async () => {
        const sender = backend.createChannel<{ runId: string }>('c1', jsonCodec())
        const listenerChannel = backend.createChannel<{ runId: string }>('c1', jsonCodec())
        const one = received<{ runId: string }>()
        const two = received<{ runId: string }>()
        const off1 = await listenerChannel.subscribe('inst-a', one.handler)
        const off2 = await sender.subscribe('inst-a', two.handler)
        await sender.publish('inst-a', { runId: 'r1' })
        await sleep(80)
        expect(one.got).toEqual([{ runId: 'r1' }])
        expect(two.got).toEqual([{ runId: 'r1' }])
        await off1()
        await off2()
      })

      it('别的频道、别的 namespace 的消息收不到', async () => {
        const channel = backend.createChannel('c2', stringCodec)
        const other = backend.createChannel('c2b', stringCodec)
        const box = received<string>()
        const off = await channel.subscribe('inst-a', box.handler)
        await channel.publish('inst-b', 'x')
        await other.publish('inst-a', 'y')
        await sleep(80)
        expect(box.got).toEqual([])
        await off()
      })

      it('退订之后不再收；订阅之前发的也收不到（只送达此刻在听的人）', async () => {
        const channel = backend.createChannel('c3', stringCodec)
        await channel.publish('inst-a', '太早了')
        await sleep(30)
        const box = received<string>()
        const off = await channel.subscribe('inst-a', box.handler)
        await channel.publish('inst-a', '一')
        await sleep(80)
        await off()
        await channel.publish('inst-a', '二')
        await sleep(80)
        expect(box.got).toEqual(['一'])
      })

      it('一个订阅者抛错不影响别的订阅者', async () => {
        const channel = backend.createChannel('c4', stringCodec)
        const box = received<string>()
        const offBad = await channel.subscribe('inst-a', () => {
          throw new Error('坏订阅者')
        })
        const offGood = await channel.subscribe('inst-a', box.handler)
        await channel.publish('inst-a', 'x')
        await sleep(80)
        expect(box.got).toEqual(['x'])
        await offBad()
        await offGood()
      })
    })
  })
}
