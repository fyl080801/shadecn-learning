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
  })
}
