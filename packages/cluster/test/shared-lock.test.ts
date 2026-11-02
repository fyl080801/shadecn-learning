import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClusterBackend } from '../src/backend.js'
import { createMemoryBackend } from '../src/memory.js'
import { createRedisBackend } from '../src/redis.js'
import { SharedLockUnavailableError } from '../src/shared-lock.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

/** 每个用例换一个 namespace，Redis 上的键互不影响；键都带 TTL，跑完自己消失 */
let round = 0
const namespace = () => `test-${process.pid}-${Date.now()}-${round++}`
const giveUp = () => Promise.resolve('fallback')

function contract(open: () => Promise<ClusterBackend>) {
  let backend: ClusterBackend

  beforeEach(async () => {
    backend = await open()
  })
  afterEach(() => backend.close())

  it('拿到锁就执行，结果原样返回', async () => {
    const result = await backend.createLock(namespace()).run('k', () => Promise.resolve('做完了'), { fallback: giveUp, ttlMs: 1000 })
    expect(result).toBe('做完了')
  })

  it('同一个键同时进来两个，任务只跑一次；后来者也拿得到结果', async () => {
    const lock = backend.createLock(namespace())
    let runs = 0
    const task = async () => {
      runs += 1
      await sleep(50)
      return '赢家'
    }
    const results = await Promise.all([
      lock.run('k', task, { fallback: giveUp, ttlMs: 2000 }),
      lock.run('k', task, { fallback: giveUp, ttlMs: 2000 }),
    ])
    expect(runs).toBe(1)
    // 两种实现给后来者的答案不同（进程内复用 promise，Redis 走 fallback），共同的契约是任务只跑一次
    expect(results).toContain('赢家')
    expect(results.every(Boolean)).toBe(true)
  })

  it('同名 namespace 的两个实例也互斥：两个模块（或两个进程）各拿一个', async () => {
    const name = namespace()
    let runs = 0
    const task = async () => {
      runs += 1
      await sleep(50)
      return 'x'
    }
    await Promise.all([
      backend.createLock(name).run('k', task, { fallback: giveUp, ttlMs: 2000 }),
      backend.createLock(name).run('k', task, { fallback: giveUp, ttlMs: 2000 }),
    ])
    expect(runs).toBe(1)
  })

  it('不同的键、不同的 namespace 互不阻塞', async () => {
    const name = namespace()
    const results = await Promise.all([
      backend.createLock(name).run('k1', () => Promise.resolve('a'), { fallback: giveUp, ttlMs: 1000 }),
      backend.createLock(name).run('k2', () => Promise.resolve('b'), { fallback: giveUp, ttlMs: 1000 }),
      backend.createLock(namespace()).run('k1', () => Promise.resolve('c'), { fallback: giveUp, ttlMs: 1000 }),
    ])
    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('任务抛异常：错误原样抛出（不是锁不可用），锁放掉', async () => {
    const lock = backend.createLock(namespace())
    const boom = new Error('炸了')
    await expect(lock.run('k', () => Promise.reject(boom), { fallback: giveUp, ttlMs: 1000 })).rejects.toBe(boom)
    expect(await lock.run('k', () => Promise.resolve('还能拿到锁'), { fallback: giveUp, ttlMs: 1000 })).toBe('还能拿到锁')
  })
}

describe('SharedLock 契约（内存）', () => {
  contract(() => Promise.resolve(createMemoryBackend()))
})

describe.skipIf(!redisUrl)('SharedLock 契约（Redis，PLATFORM_TEST_REDIS_URL）', () => {
  contract(() => createRedisBackend(redisUrl as string))
})

describe.skipIf(!redisUrl)('SharedLock 的 Redis 专属语义', () => {
  const url = redisUrl as string
  // 模拟「另一个进程」：一条独立的连接，一个独立的 backend
  const other = new Redis(url)
  let backend: ClusterBackend

  beforeEach(async () => {
    backend = await createRedisBackend(url)
  })
  afterEach(() => backend.close().catch(() => undefined))
  afterAll(() => {
    other.disconnect()
  })

  it('跨进程：赢家做完放锁后，输家才跑 fallback，且 task 不跑', async () => {
    const peer = await createRedisBackend(url)
    const name = namespace()
    const events: string[] = []
    const winner = peer.createLock(name).run(
      'k',
      async () => {
        await sleep(100)
        events.push('赢家做完')
        return 'w'
      },
      { fallback: giveUp, ttlMs: 2000 },
    )
    await sleep(20)
    const loser = await backend.createLock(name).run(
      'k',
      () => {
        events.push('输家也跑了 task')
        return Promise.resolve('l')
      },
      {
        ttlMs: 2000,
        fallback: () => {
          events.push('输家 fallback')
          return Promise.resolve('reread')
        },
      },
    )
    expect(await winner).toBe('w')
    expect(loser).toBe('reread')
    expect(events).toEqual(['赢家做完', '输家 fallback'])
    await peer.close()
  })

  it('赢家崩了（锁没人放）：输家等到 TTL 过期后跑 fallback，不跑 task；过期之后别人能重新抢到', async () => {
    const name = namespace()
    await other.set(`learning:${name}:k`, 'crashed-holder', 'PX', 150)
    const startedAt = Date.now()
    let ran = false
    const result = await backend.createLock(name).run(
      'k',
      () => {
        ran = true
        return Promise.resolve('task')
      },
      { fallback: giveUp, ttlMs: 2000 },
    )
    expect(result).toBe('fallback')
    expect(ran).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(await backend.createLock(name).run('k', () => Promise.resolve('task'), { fallback: giveUp, ttlMs: 1000 })).toBe('task')
  })

  it('等的时间不超过 ttlMs：别人一直占着，也会放弃等待去跑 fallback', async () => {
    const name = namespace()
    await other.set(`learning:${name}:k`, 'long-holder', 'PX', 5000)
    const startedAt = Date.now()
    expect(await backend.createLock(name).run('k', () => Promise.resolve('task'), { fallback: giveUp, ttlMs: 100 })).toBe('fallback')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    await other.del(`learning:${name}:k`)
  })

  it('task 超过 TTL：释放时不会删掉新持有者的锁', async () => {
    const name = namespace()
    const full = `learning:${name}:k`
    await backend.createLock(name).run(
      'k',
      async () => {
        await sleep(120)
        // 我的锁已经过期，别的进程抢到了
        await other.set(full, 'new-holder', 'PX', 5000)
      },
      { fallback: () => Promise.resolve(), ttlMs: 50 },
    )
    expect(await other.get(full)).toBe('new-holder')
    await other.del(full)
  })

  it('task 正常结束：键被删掉，不留到 TTL', async () => {
    const name = namespace()
    await backend.createLock(name).run('k', () => Promise.resolve(), { fallback: () => Promise.resolve(), ttlMs: 60_000 })
    expect(await other.exists(`learning:${name}:k`)).toBe(0)
  })

  it('连接断了：抛 SharedLockUnavailableError，task 不跑，错误不带地址', async () => {
    const lock = backend.createLock(namespace())
    await backend.close()
    let ran = false
    const failure = lock.run(
      'k',
      () => {
        ran = true
        return Promise.resolve()
      },
      { fallback: () => Promise.resolve(), ttlMs: 1000 },
    )
    await expect(failure).rejects.toBeInstanceOf(SharedLockUnavailableError)
    expect(ran).toBe(false)
    await expect(failure).rejects.not.toThrow(url)
  })

  it('对面不回话（网络黑洞、容器暂停）：SET 超时后抛不可用；恢复后服务端才执行到它，不留幽灵锁', async () => {
    // TCP 代理：stalled 时把客户端发的字节攒着不转发，模拟 Redis 暂停（连接没断，也不回话）
    const target = new URL(url)
    let stalled = false
    const held: Array<() => void> = []
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port), target.hostname)
      client.on('data', (chunk) => {
        if (stalled) held.push(() => upstream.write(chunk))
        else upstream.write(chunk)
      })
      upstream.on('data', (chunk) => client.write(chunk))
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      client.on('error', () => undefined)
      upstream.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxied = await createRedisBackend(`redis://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)

    const name = namespace()
    const full = `learning:${name}:k`
    stalled = true
    let ran = false
    const failure = proxied.createLock(name).run(
      'k',
      () => {
        ran = true
        return Promise.resolve()
      },
      { fallback: () => Promise.resolve(), ttlMs: 30_000 },
    )
    await expect(failure).rejects.toBeInstanceOf(SharedLockUnavailableError)
    expect(ran).toBe(false)

    // 恢复：攒着的字节到了服务端。客户端早就放弃了，这把锁没人会放，别的进程要白等一个 TTL
    stalled = false
    for (const flush of held) flush()
    await sleep(100)
    expect(await other.exists(full)).toBe(0)

    await proxied.close()
    await new Promise((resolve) => proxy.close(resolve))
  }, 15_000)

  it('等待途中 Redis 坏了：不算失败，跑 fallback', async () => {
    const name = namespace()
    await other.set(`learning:${name}:k`, 'holder', 'PX', 3000)
    const pending = backend.createLock(name).run('k', () => Promise.resolve('task'), { fallback: giveUp, ttlMs: 3000 })
    await sleep(60)
    await backend.close()
    expect(await pending).toBe('fallback')
    await other.del(`learning:${name}:k`)
  })
})

describe('连不上 Redis', () => {
  it('启动失败，错误不带密码，不留后台重连（进程能退出）', async () => {
    const failure = createRedisBackend('redis://:hunter2-secret@127.0.0.1:1')
    await expect(failure).rejects.toThrow('连不上 Redis')
    await expect(failure).rejects.not.toThrow('hunter2')
  })
})
