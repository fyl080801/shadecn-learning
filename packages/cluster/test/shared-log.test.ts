import 'reflect-metadata'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { testConfigModule } from '@learning/config/testing'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterBackend } from '../src/backend.js'
import { Cluster, ClusterModule } from '../src/index.js'
import { createMemoryBackend, type MemoryLogState } from '../src/memory.js'
import { createRedisBackend } from '../src/redis.js'
import { jsonCodec, stringCodec } from '../src/shared-state.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

let round = 0
const unique = (name = 'g') => `test-${name}-${process.pid}-${Date.now()}-${round++}`
const values = <V>(entries: { value: V }[]) => entries.map((entry) => entry.value)

/** 同一套契约：`peer` 是「另一个进程」。内存实现只有一个进程，所以是同一个 backend；Redis 是另一条连接 */
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
  })

  it('按追加的顺序读出来；从某一条之后接着读不漏不重；id 和 append 返回的一致', async () => {
    const log = backend.createLog<{ n: number }>(unique(), jsonCodec())
    const ids: string[] = []
    for (let n = 1; n <= 4; n += 1) ids.push(await log.append('k', { n }))
    expect(values(await log.read('k', null))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
    expect(values(await log.read('k', ids[1] as string))).toEqual([{ n: 3 }, { n: 4 }])
    expect(await log.read('k', ids[3] as string)).toEqual([])
    expect((await log.read('k', null)).map((entry) => entry.id)).toEqual(ids)
  })

  it('没写过的日志是空的；不同的键、不同的 namespace 互不干扰', async () => {
    const a = backend.createLog(unique(), stringCodec)
    const b = backend.createLog(unique(), stringCodec)
    expect(await a.read('nope', null)).toEqual([])
    await a.append('k1', 'a1', { ttlMs: 5000 })
    await a.append('k2', 'a2', { ttlMs: 5000 })
    await b.append('k1', 'b1', { ttlMs: 5000 })
    expect(values(await a.read('k1', null))).toEqual(['a1'])
    expect(values(await a.read('k2', null))).toEqual(['a2'])
    expect(values(await b.read('k1', null))).toEqual(['b1'])
  })

  it('同名 namespace 跨实例是同一份', async () => {
    const name = unique()
    await backend.createLog(name, stringCodec).append('k', 'x', { ttlMs: 5000 })
    expect(values(await peer.createLog(name, stringCodec).read('k', null))).toEqual(['x'])
  })

  it('值经 codec 存取：读出来是新对象，不和写的一方共享引用', async () => {
    const log = backend.createLog<{ tags: string[] }>(unique(), jsonCodec())
    const value = { tags: ['节点'] }
    await log.append('k', value, { ttlMs: 5000 })
    value.tags.push('改了')
    const [first, second] = [await log.read('k', null), await log.read('k', null)]
    expect(values(first)).toEqual([{ tags: ['节点'] }])
    expect(first[0]?.value).not.toBe(second[0]?.value)
  })

  it('maxLen 精确裁剪：只留最近的那么多条，从最老的删起', async () => {
    const log = backend.createLog(unique(), stringCodec)
    for (let n = 1; n <= 5; n += 1) await log.append('k', String(n), { maxLen: 3, ttlMs: 5000 })
    expect(values(await log.read('k', null))).toEqual(['3', '4', '5'])
  })

  it('游标落在被裁掉的位置：读到还在的那些，有没有漏由读的一方判断', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const old = await log.append('k', '1', { ttlMs: 5000 })
    for (let n = 2; n <= 5; n += 1) await log.append('k', String(n), { maxLen: 2, ttlMs: 5000 })
    expect(values(await log.read('k', old))).toEqual(['4', '5'])
    expect(values(await log.wait('k', old, 1000))).toEqual(['4', '5'])
  })

  it('wait：已经有就立刻返回，不等', async () => {
    const log = backend.createLog(unique(), stringCodec)
    await log.append('k', 'a', { ttlMs: 5000 })
    const started = Date.now()
    expect(values(await log.wait('k', null, 5000))).toEqual(['a'])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('wait：没有就等到新条目，别的实例写的也能唤醒，不等满 blockMs', async () => {
    const name = unique()
    const log = backend.createLog(name, stringCodec)
    const first = await log.append('k', 'a', { ttlMs: 10_000 })
    const started = Date.now()
    const waiting = log.wait('k', first, 8000)
    await sleep(100)
    await peer.createLog(name, stringCodec).append('k', 'b', { ttlMs: 10_000 })
    expect(values(await waiting)).toEqual(['b'])
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('wait：日志还不存在时也等，写出第一条就醒', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const waiting = log.wait('k', null, 8000)
    await sleep(100)
    await log.append('k', '第一条', { ttlMs: 5000 })
    expect(values(await waiting)).toEqual(['第一条'])
  })

  it('wait：到点没有新条目返回空数组，不提前回', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const last = await log.append('k', 'a', { ttlMs: 5000 })
    const started = Date.now()
    expect(await log.wait('k', last, 300)).toEqual([])
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(elapsed).toBeLessThan(2000)
  })

  it('wait：blockMs 是 0 或小数也会到点返回，不会变成永远等（BLOCK 0）', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const last = await log.append('k', 'a', { ttlMs: 5000 })
    await expect(Promise.race([log.wait('k', last, 0), sleep(1500, 'stuck')])).resolves.toEqual([])
    await expect(Promise.race([log.wait('k', last, 0.5), sleep(1500, 'stuck')])).resolves.toEqual([])
  })

  it('wait：别的键、别的 namespace 的条目叫不醒', async () => {
    const name = unique()
    const log = backend.createLog(name, stringCodec)
    const waiting = log.wait('k', null, 400)
    await sleep(100)
    await log.append('other', 'x', { ttlMs: 5000 })
    await backend.createLog(unique(), stringCodec).append('k', 'y', { ttlMs: 5000 })
    expect(await waiting).toEqual([])
  })

  it('多个消费者：同时等的都醒，各按自己的游标拿到各自该拿的', async () => {
    const name = unique()
    const log = backend.createLog(name, stringCodec)
    const other = peer.createLog(name, stringCodec)
    const first = await log.append('k', 'a', { ttlMs: 10_000 })
    const second = await log.append('k', 'b', { ttlMs: 10_000 })
    const waits = [log.wait('k', second, 8000), other.wait('k', second, 8000), log.wait('k', second, 8000)]
    await sleep(100)
    await log.append('k', 'c', { ttlMs: 10_000 })
    for (const got of await Promise.all(waits)) expect(values(got)).toEqual(['c'])
    // 落后的消费者从自己的游标接着读，不受别人影响
    expect(values(await other.wait('k', first, 1000))).toEqual(['b', 'c'])
  })

  it('消费者循环 wait 跟着写的一方走：不漏不重、顺序不变', async () => {
    const name = unique()
    const reader = peer.createLog<number>(name, jsonCodec())
    const writer = backend.createLog<number>(name, jsonCodec())
    const total = 50
    const consume = (async () => {
      const seen: number[] = []
      let cursor: string | null = null
      while (seen.length < total) {
        const batch = await reader.wait('k', cursor, 2000)
        for (const entry of batch) {
          cursor = entry.id
          seen.push(entry.value)
        }
      }
      return seen
    })()
    for (let n = 0; n < total; n += 1) {
      await writer.append('k', n, { ttlMs: 10_000 })
      if (n % 10 === 0) await sleep(5)
    }
    expect(await consume).toEqual(Array.from({ length: total }, (_, n) => n))
  })

  it('TTL：整份日志到点消失；expire 续上就还在；日志不存在时 expire 返回 false', async () => {
    const log = backend.createLog(unique(), stringCodec)
    await log.append('k', 'a', { ttlMs: 400 })
    await sleep(250)
    expect(await log.expire('k', 500)).toBe(true)
    await sleep(300)
    // 原 TTL 早该到了，续过所以还在
    expect(values(await log.read('k', null))).toEqual(['a'])
    await sleep(350)
    expect(await log.read('k', null)).toEqual([])
    expect(await log.expire('k', 500)).toBe(false)
  })

  it('append 不给 ttlMs 不动原来的过期时间；给了就重设，每一条都续整份', async () => {
    const log = backend.createLog(unique(), stringCodec)
    await log.append('k', 'a', { ttlMs: 300 })
    await log.append('k', 'b')
    await sleep(400)
    expect(await log.read('k', null)).toEqual([])

    await log.append('k', 'c', { ttlMs: 400 })
    await sleep(250)
    await log.append('k', 'd', { ttlMs: 400 })
    await sleep(250)
    expect(values(await log.read('k', null))).toEqual(['c', 'd'])
  })

  it('过期后重建：新条目的 id 排在旧游标之后，拿旧游标读得到', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const old = await log.append('k', 'a', { ttlMs: 60 })
    await sleep(120)
    await log.append('k', 'b', { ttlMs: 5000 })
    expect(values(await log.read('k', old))).toEqual(['b'])
  })

  it('等待途中日志过期：不影响等的人，之后重建的日志照样叫醒它', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const last = await log.append('k', 'a', { ttlMs: 100 })
    const waiting = log.wait('k', last, 8000)
    await sleep(250)
    await log.append('k', 'b', { ttlMs: 5000 })
    expect(values(await waiting)).toEqual(['b'])
  })

  it('关闭：等待中的 wait 立刻返回空数组；之后再调 reject，循环的调用方不会空转', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const started = Date.now()
    const waits = [log.wait('k', null, 60_000), log.wait('other', null, 60_000)]
    await sleep(100)
    await backend.close()
    expect(await Promise.all(waits)).toEqual([[], []])
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(log.wait('k', null, 60_000)).rejects.toThrow()
  })
}

describe('SharedLog 契约（内存）', () => {
  contract(
    () => Promise.resolve(createMemoryBackend()),
    (backend) => Promise.resolve({ ...backend, close: () => Promise.resolve() }),
  )
})

describe('内存实现的日志', () => {
  it('过期的日志新建时清掉：常驻进程不会每一轮都留下一份', async () => {
    const logs = new Map<string, MemoryLogState>()
    const log = createMemoryBackend(logs).createLog('g', stringCodec)
    await log.append('run-1', 'a', { ttlMs: 30 })
    await log.append('run-2', 'a', { ttlMs: 5000 })
    await sleep(60)
    await log.append('run-3', 'a', { ttlMs: 5000 })
    expect([...logs.keys()].sort()).toEqual(['g:run-2', 'g:run-3'])
  })

  it('wait 不留东西：等完之后日志表是空的', async () => {
    const logs = new Map<string, MemoryLogState>()
    const log = createMemoryBackend(logs).createLog('g', stringCodec)
    expect(await log.wait('k', null, 20)).toEqual([])
    expect(logs.size).toBe(0)
  })
})

describe.skipIf(!redisUrl)('SharedLog 契约（Redis，PLATFORM_TEST_REDIS_URL）', () => {
  contract(
    () => createRedisBackend(redisUrl as string),
    () => createRedisBackend(redisUrl as string),
  )
})

describe.skipIf(!redisUrl)('SharedLog 的 Redis 专属语义', () => {
  // 单独一个逻辑库：同一个 Redis 上别的 project（agent 的接回、真进程的退出用例）也开阻塞连接，名字一样，按库分开才数得准
  const BLOCKING_DB = 9
  const url = (redisUrl && Object.assign(new URL(redisUrl), { pathname: `/${BLOCKING_DB}` }).href) as string
  const admin = new Redis(url)
  let backend: ClusterBackend

  /** 阻塞连接都带这个名字，同文件的用例串行 */
  const blockingClients = async () =>
    ((await admin.call('CLIENT', 'LIST', 'TYPE', 'normal')) as string)
      .split('\n')
      .filter((line) => line.includes(' name=learning-cluster-log ') && line.includes(` db=${BLOCKING_DB} `))
      .map((line) => /^id=(\d+) /.exec(line)?.[1] as string)

  beforeEach(async () => {
    backend = await createRedisBackend(url)
  })
  afterEach(() => backend.close())
  afterAll(() => {
    admin.disconnect()
  })

  it('一个键一条 stream：追加和续期在同一个事务里，MAXLEN 是精确的', async () => {
    const name = unique()
    const log = backend.createLog(name, stringCodec)
    for (let n = 0; n < 200; n += 1) await log.append('k', String(n), { maxLen: 7, ttlMs: 5000 })
    const full = `learning:${name}:k`
    expect(await admin.type(full)).toBe('stream')
    expect(await admin.xlen(full)).toBe(7)
    const ttl = await admin.pttl(full)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(5000)
    expect(await log.expire('k', 60_000)).toBe(true)
    expect(await admin.pttl(full)).toBeGreaterThan(5000)
    await admin.del(full)
  })

  it('wait 不占主连接：等的时候别的命令照常走', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const map = backend.createMap(unique('m'), stringCodec)
    const waiting = log.wait('k', null, 1500)
    await sleep(100)
    const started = Date.now()
    await map.set('k', 'v', 1000)
    expect(await map.get('k')).toBe('v')
    expect(Date.now() - started).toBeLessThan(500)
    expect(await waiting).toEqual([])
  })

  it('阻塞时间可以超过主连接的 commandTimeout（2 秒），到点才回空，消息也等得到', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const started = Date.now()
    expect(await log.wait('k', null, 2500)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(2400)

    const waiting = log.wait('k', null, 5000)
    await sleep(2300)
    await log.append('k', 'late', { ttlMs: 5000 })
    expect(values(await waiting)).toEqual(['late'])
  }, 15_000)

  it('阻塞连接按需才建，用完复用；关闭后 Redis 上不留', async () => {
    const before = (await blockingClients()).length
    const log = backend.createLog(unique(), stringCodec)
    const last = await log.append('k', 'a', { ttlMs: 5000 })
    await log.read('k', null)
    // 已经有条目的 wait 不借连接
    await log.wait('k', null, 100)
    expect((await blockingClients()).length).toBe(before)

    for (let n = 0; n < 3; n += 1) await log.wait('k', last, 20)
    expect((await blockingClients()).length).toBe(before + 1)

    await backend.close()
    await vi.waitFor(async () => expect((await blockingClients()).length).toBe(before))
  })

  it('关闭时还堵在 XREAD 上的连接也断开：不等 blockMs 到点，Redis 上立刻不留', async () => {
    const before = (await blockingClients()).length
    const log = backend.createLog(unique(), stringCodec)
    const waits = [log.wait('k', null, 60_000), log.wait('other', null, 60_000)]
    await sleep(150)
    expect((await blockingClients()).length).toBe(before + 2)
    await backend.close()
    expect(await Promise.all(waits)).toEqual([[], []])
    await vi.waitFor(async () => expect((await blockingClients()).length).toBe(before), { timeout: 1000 })
  })

  it('连接有上限：20 个读者同时等，最多 16 条，超出的退回轮询，都醒；用完最多留 4 条', async () => {
    const before = (await blockingClients()).length
    const log = backend.createLog(unique(), stringCodec)
    const waits = Array.from({ length: 20 }, () => log.wait('k', null, 8000))
    await sleep(300)
    expect((await blockingClients()).length).toBe(before + 16)
    const started = Date.now()
    await log.append('k', 'x', { ttlMs: 5000 })
    for (const got of await Promise.all(waits)) expect(values(got)).toEqual(['x'])
    expect(Date.now() - started).toBeLessThan(2000)
    await vi.waitFor(async () => expect((await blockingClients()).length).toBe(before + 4))
  }, 15_000)

  it('退回轮询的读者：同样等满 blockMs 才回空；关闭时立刻回', async () => {
    const log = backend.createLog(unique(), stringCodec)
    const holders = Array.from({ length: 16 }, () => log.wait('k', null, 60_000))
    await sleep(200)

    const started = Date.now()
    expect(await log.wait('k', null, 700)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(680)

    const closing = Date.now()
    const polling = log.wait('k', null, 60_000)
    await sleep(100)
    await backend.close()
    expect(await polling).toEqual([])
    expect(await Promise.all(holders)).toEqual(holders.map(() => []))
    expect(Date.now() - closing).toBeLessThan(2000)
  }, 15_000)

  it('阻塞连接断了：等的人 reject（重试归调用方），health 不受影响，下一次 wait 开新连接', async () => {
    const before = await blockingClients()
    const log = backend.createLog(unique(), stringCodec)
    const waiting = log.wait('k', null, 60_000)
    const failed = waiting.then(() => false, () => true)
    await sleep(150)
    const [mine] = (await blockingClients()).filter((id) => !before.includes(id))
    await admin.call('CLIENT', 'KILL', 'ID', mine as string)
    await expect(Promise.race([failed, sleep(2000, 'stuck')])).resolves.toBe(true)
    expect(backend.health().ok).toBe(true)

    const next = log.wait('k', null, 5000)
    await sleep(100)
    await log.append('k', 'x', { ttlMs: 5000 })
    expect(values(await next)).toEqual(['x'])
  })

  it('连接断了：append、read、wait、expire 都 reject，不是回空（空的意思是「还没有」）', async () => {
    const log = backend.createLog(unique(), stringCodec)
    await backend.close()
    await expect(log.append('k', 'x')).rejects.toThrow()
    await expect(log.read('k', null)).rejects.toThrow()
    await expect(log.wait('k', null, 100)).rejects.toThrow()
    await expect(log.expire('k', 100)).rejects.toThrow()
  })

  describe('对面不回话（网络黑洞、容器暂停）', () => {
    /** TCP 代理：stalled 时两个方向都不转发，模拟 Redis 暂停（连接没断，也不回话）。stallNew 只卡之后建的连接 */
    async function stallingProxy() {
      const target = new URL(url)
      const control = { stalled: false, stallNew: false }
      const sockets = new Set<net.Socket>()
      const proxy = net.createServer((client) => {
        const upstream = net.connect(Number(target.port), target.hostname)
        const stuck = control.stallNew
        sockets.add(client).add(upstream)
        client.on('data', (chunk) => {
          if (!stuck && !control.stalled) upstream.write(chunk)
        })
        upstream.on('data', (chunk) => {
          if (!stuck && !control.stalled) client.write(chunk)
        })
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
        client.on('error', () => undefined)
        upstream.on('error', () => undefined)
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      return {
        control,
        url: `redis://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
        close: () => {
          for (const socket of sockets) socket.destroy()
          return new Promise((resolve) => proxy.close(resolve))
        },
      }
    }

    it('等待中的 wait 不会永远挂着：blockMs + 命令超时之后 reject，连接换新的', async () => {
      const proxy = await stallingProxy()
      const proxied = await createRedisBackend(proxy.url)
      const log = proxied.createLog(unique(), stringCodec)
      // 先等一次，留下一条能复用的连接：新建的连接还要多算一个连接超时（下一个用例）
      await log.wait('k', null, 10)
      const started = Date.now()
      const waiting = log.wait('k', null, 300)
      await sleep(100)
      proxy.control.stalled = true
      await expect(waiting).rejects.toThrow('对面不回话')
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(2200)
      expect(elapsed).toBeLessThan(4000)

      proxy.control.stalled = false
      const next = log.wait('k', null, 5000)
      await sleep(100)
      await log.append('k', 'x', { ttlMs: 5000 })
      expect(values(await next)).toEqual(['x'])
      await proxied.close()
      await proxy.close()
    }, 15_000)

    it('新建阻塞连接时卡住（TCP 通，握手不回）：到点 reject，不挂着', async () => {
      const proxy = await stallingProxy()
      const proxied = await createRedisBackend(proxy.url)
      const log = proxied.createLog(unique(), stringCodec)
      proxy.control.stallNew = true
      const started = Date.now()
      await expect(log.wait('k', null, 100)).rejects.toThrow('对面不回话')
      expect(Date.now() - started).toBeLessThan(9000)
      await proxied.close()
      await proxy.close()
    }, 15_000)

    it('append、read、expire 受命令超时约束，会 reject', async () => {
      const proxy = await stallingProxy()
      const proxied = await createRedisBackend(proxy.url)
      const log = proxied.createLog(unique(), stringCodec)
      proxy.control.stalled = true
      const started = Date.now()
      await expect(log.append('k', 'x', { ttlMs: 1000 })).rejects.toThrow()
      await expect(log.read('k', null)).rejects.toThrow()
      await expect(log.expire('k', 1000)).rejects.toThrow()
      await expect(log.wait('k', null, 100)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(12_000)
      await proxied.close()
      await proxy.close()
    }, 20_000)

    it('关闭不被卡住：等待中的 wait 立刻返回，close 受命令超时约束', async () => {
      const proxy = await stallingProxy()
      const proxied = await createRedisBackend(proxy.url)
      const log = proxied.createLog(unique(), stringCodec)
      const waiting = log.wait('k', null, 60_000)
      await sleep(100)
      proxy.control.stalled = true
      const started = Date.now()
      const closing = proxied.close()
      expect(await waiting).toEqual([])
      expect(Date.now() - started).toBeLessThan(200)
      await closing
      expect(Date.now() - started).toBeLessThan(4000)
      await proxy.close()
    }, 15_000)
  })
})

describe('Nest 关闭流程里的 SharedLog', () => {
  @Module({})
  class Root {}

  const boot = (values: Record<string, unknown>) =>
    NestFactory.createApplicationContext({ module: Root, imports: [testConfigModule(values), ClusterModule] }, { logger: false, abortOnError: false })

  const closesWhileBlocked = async (config: Record<string, unknown>) => {
    const app = await boot(config)
    const log = app.get(Cluster).createLog(unique(), stringCodec)
    const waiting = log.wait('k', null, 60_000)
    await sleep(100)
    const started = Date.now()
    await app.close()
    expect(await waiting).toEqual([])
    expect(Date.now() - started).toBeLessThan(1500)
  }

  it('single：有人在 wait 时 app.close() 不挂，wait 立刻返回', () => closesWhileBlocked({}))

  it.skipIf(!redisUrl)('redis：有人在 wait 时 app.close() 不挂，wait 立刻返回', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await closesWhileBlocked({ cluster: { mode: 'redis', url: redisUrl } })
    vi.restoreAllMocks()
  })
})
