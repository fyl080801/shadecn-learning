import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import type { ClusterBackend } from './backend.js'
import { SharedLock, SharedLockUnavailableError } from './shared-lock.js'

/**
 * Redis 实现。只有 `redis` 模式才加载这个文件（`cluster.ts` 动态 import），`single` 模式连 ioredis 都不加载，和两个数据库驱动一个套路。
 *
 * 连接选项都是为了「Redis 出问题时请求不能跟着挂」，锁在请求路径上：
 * - `enableOfflineQueue: false`：断线时命令立刻失败，不排队；调用方降级，连接在后台继续重连；
 * - `commandTimeout`：对面不回话（网络黑洞、容器暂停）时不是连接错误，只有它能把命令放开；
 * - `autoResendUnfulfilledCommands: false`：调用方已经放弃的 `SET NX` 不能在重连后悄悄重发，否则留下一把没人释放的锁，别的进程白等一个 TTL。
 */
const COMMAND_TIMEOUT_MS = 2000
const CONNECT_TIMEOUT_MS = 5000

/** 没抢到锁时的轮询间隔 */
const LOCK_POLL_INTERVAL_MS = 20

/** 所有键的前缀：一台 Redis 上可能还有 `apps/server` 的键（`shadecn:`） */
const KEY_PREFIX = 'learning'

/** 释放锁：只有还持有 token 的人才删得掉。过期之后锁可能已经是别人的，不能删掉别人的那把 */
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

class RedisLock extends SharedLock {
  readonly #redis: Redis
  readonly #prefix: string

  constructor(redis: Redis, prefix: string, namespace: string) {
    super(namespace)
    this.#redis = redis
    this.#prefix = `${prefix}:${namespace}:`
  }

  async run<T>(key: string, task: () => Promise<T>, options: { fallback: () => Promise<T>; ttlMs: number }): Promise<T> {
    const full = `${this.#prefix}${key}`
    const token = randomUUID()

    let acquired: string | null
    try {
      acquired = await this.#redis.set(full, token, 'PX', options.ttlMs, 'NX')
    } catch (err) {
      // 超时不等于没执行：对面只是不回话时（容器暂停、网络黑洞），这句 SET 还在 socket 里，恢复后服务端照样执行，留下一把没人放的锁，
      // 别的进程白等一个 TTL（实测）。跟着发一句释放，同一条连接保证先 SET 后释放。连接断了发不出去就只能等 TTL
      this.#redis.eval(RELEASE_LOCK, 1, full, token).catch(() => undefined)
      throw new SharedLockUnavailableError(err)
    }

    if (acquired === 'OK') {
      try {
        return await task()
      } finally {
        // 放不掉就算了：TTL 到了自己消失，只是别人多等一会儿，不能让它盖掉 task 的结果
        await this.#redis.eval(RELEASE_LOCK, 1, full, token).catch(() => undefined)
      }
    }

    // 没抢到：等赢家做完（或锁过期），然后自己去看结果。等的途中 Redis 坏了也一样去看：fallback 不依赖锁，本来就要自己得出答案
    const deadline = Date.now() + options.ttlMs
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS)
      try {
        if ((await this.#redis.exists(full)) === 0) break
      } catch {
        break
      }
    }
    return options.fallback()
  }
}

/** 连不上就抛：redis 模式下锁是正确性的一部分，起不来要在启动阶段就炸。错误信息不带连接串（里面可能有密码） */
export async function createRedisBackend(url: string): Promise<ClusterBackend> {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
  })

  // 后台重连每次失败都会触发，同一个错误只打一次，连上之后再记
  let lastError: string | undefined
  redis.on('error', (err: Error) => {
    if (err.message === lastError) return
    lastError = err.message
    console.error(`[cluster] Redis 连接出错：${err.message}`)
  })
  redis.on('ready', () => {
    if (lastError !== undefined) console.log('[cluster] Redis 连接已恢复')
    lastError = undefined
  })

  try {
    await redis.connect()
  } catch (err) {
    redis.disconnect()
    throw new Error(`[cluster] 连不上 Redis，中止启动：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  return {
    createLock: (namespace) => new RedisLock(redis, KEY_PREFIX, namespace),
    close: async () => {
      // quit 等服务端回话，连不上时立刻失败，黑洞时受 commandTimeout 约束。disconnect 才能停掉后台重连
      await redis.quit().catch(() => undefined)
      redis.disconnect()
    },
  }
}
