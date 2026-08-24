import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  SharedCounter,
  SharedLock,
  SharedMap,
  type ClusterBackend,
  type Codec,
} from './shared.ts'

/**
 * 多副本实现 —— 三个抽象各自落到 Redis 上最贴切的那个原语：
 *
 * | 抽象 | Redis |
 * |---|---|
 * | `SharedMap.get/set` | `GET` / `SET [PX]` |
 * | `SharedMap.claim` | `SET NX` —— 判断加写入必须是一个原子动作 |
 * | `SharedMap.entries` | `SCAN MATCH` + `MGET`（冷路径专用） |
 * | `SharedCounter.next` | `INCR`，键不存在时先按库里的最大值播种 |
 * | `SharedLock.run` | `SET NX PX` + 带 token 的 Lua 释放 |
 *
 * **这个模块只在 `CLUSTER_MODE=redis` 时被动态 import**（`cluster/index.ts` 的
 * `initCluster`），所以单副本进程里 ioredis 连加载都不会发生，构建产物也不带它 ——
 * 和 `server/db.ts` 对两个 Prisma adapter 的处理是同一套路数。
 */

/** 释放锁：只有还持有 token 的人才删得掉，避免删掉别人续上的那把 */
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

/** 没抢到锁时的轮询间隔 */
const LOCK_POLL_INTERVAL = 20

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一批一批地扫，别用 KEYS（它会阻塞整个 Redis） */
async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = next
    found.push(...batch)
  } while (cursor !== '0')
  return found
}

class RedisMap<V> extends SharedMap<V> {
  readonly #redis: Redis
  readonly #prefix: string

  constructor(redis: Redis, prefix: string, namespace: string, codec: Codec<V>) {
    super(namespace, codec)
    this.#redis = redis
    this.#prefix = `${prefix}:${namespace}:`
  }

  #full(key: string) {
    return `${this.#prefix}${key}`
  }

  async get(key: string): Promise<V | undefined> {
    const raw = await this.#redis.get(this.#full(key))
    return raw === null ? undefined : this.codec.decode(raw)
  }

  async set(key: string, value: V, ttlMs?: number): Promise<void> {
    const encoded = this.codec.encode(value)
    if (ttlMs) await this.#redis.set(this.#full(key), encoded, 'PX', ttlMs)
    else await this.#redis.set(this.#full(key), encoded)
  }

  async claim(key: string, value: V, ttlMs?: number): Promise<boolean> {
    const encoded = this.codec.encode(value)
    const result = ttlMs
      ? await this.#redis.set(this.#full(key), encoded, 'PX', ttlMs, 'NX')
      : await this.#redis.set(this.#full(key), encoded, 'NX')
    return result === 'OK'
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(this.#full(key))
  }

  async entries(prefix = ''): Promise<[string, V][]> {
    const keys = await scanKeys(this.#redis, `${this.#prefix}${prefix}*`)
    if (keys.length === 0) return []

    const values = await this.#redis.mget(keys)
    const result: [string, V][] = []
    keys.forEach((key, index) => {
      const raw = values[index]
      // 扫到和读到之间可能刚好过期，这种就当它不存在
      if (raw === null || raw === undefined) return
      result.push([key.slice(this.#prefix.length), this.codec.decode(raw)])
    })
    return result
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const keys = await scanKeys(this.#redis, `${this.#prefix}${prefix}*`)
    if (keys.length > 0) await this.#redis.del(...keys)
  }
}

class RedisCounter extends SharedCounter {
  readonly #redis: Redis
  readonly #prefix: string

  constructor(redis: Redis, prefix: string, namespace: string) {
    super(namespace)
    this.#redis = redis
    this.#prefix = `${prefix}:${namespace}:`
  }

  #full(key: string) {
    return `${this.#prefix}${key}`
  }

  /**
   * 号码机。
   *
   * **播种不能省**：Redis 是缓存，随时可能被清空或重启。真那样之后直接 `INCR`
   * 会从 1 开始，撞上库里已经写下的 `@@unique([flowId, seq])`。所以键不存在时
   * 先按库里的最大值把它设成「已用到这里」，再 `INCR` —— 恢复之后的第一个号
   * 正好接着上次。`SET NX` 保证同时开工的多个实例只有一个播得进去。
   */
  async next(key: string, seed: () => Promise<number>): Promise<number> {
    const full = this.#full(key)
    if ((await this.#redis.exists(full)) === 0) {
      const seeded = await seed()
      // 播种期间别人可能已经播过并 INCR 过了；NX 会失败，下面的 INCR 依然正确
      await this.#redis.set(full, String(seeded), 'NX')
    }
    return this.#redis.incr(full)
  }

  async forget(key: string): Promise<void> {
    await this.#redis.del(this.#full(key))
  }
}

class RedisLock extends SharedLock {
  readonly #redis: Redis
  readonly #prefix: string

  constructor(redis: Redis, prefix: string, namespace: string) {
    super(namespace)
    this.#redis = redis
    this.#prefix = `${prefix}:${namespace}:`
  }

  async run<T>(
    key: string,
    task: () => Promise<T>,
    options: { fallback: () => Promise<T>; ttlMs?: number },
  ): Promise<T> {
    const full = `${this.#prefix}${key}`
    const ttl = options.ttlMs ?? 10_000
    const token = randomUUID()

    const acquired = await this.#redis.set(full, token, 'PX', ttl, 'NX')
    if (acquired === 'OK') {
      try {
        return await task()
      } finally {
        await this.#redis.eval(RELEASE_LOCK, 1, full, token).catch(() => undefined)
      }
    }

    // 没抢到：等赢家做完（或锁过期），然后自己去看结果。
    // 这里等的是「别人做完了」，所以 fallback 必须能独立得出答案 —— 通常是重读一遍库
    const deadline = Date.now() + ttl
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL)
      if ((await this.#redis.exists(full)) === 0) break
    }
    return options.fallback()
  }
}

export interface RedisBackendOptions {
  url: string
  prefix: string
}

export async function createRedisBackend(options: RedisBackendOptions): Promise<ClusterBackend> {
  const redis = new Redis(options.url, {
    // 命令在断线期间排队而不是立刻失败：Redis 抖一下不该让一次编辑直接报错
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  })

  redis.on('error', (err: Error) => console.error('[cluster] Redis 连接出错', err.message))

  // 连不上就别装作没事：多副本模式下这些共享状态是正确性的一部分，
  // 起不来要在启动阶段就炸，而不是等第一次写冲突才发现
  await redis.connect()

  return {
    createMap: <V>(namespace: string, codec: Codec<V>) =>
      new RedisMap<V>(redis, options.prefix, namespace, codec),
    createCounter: (namespace: string) => new RedisCounter(redis, options.prefix, namespace),
    createLock: (namespace: string) => new RedisLock(redis, options.prefix, namespace),
    /*
     * 读 ioredis 自己维护的连接状态，**不发 PING**：健康检查不能因为
     * Redis 慢就跟着卡住。`ready` 才算好使 —— `connecting` / `reconnecting`
     * 期间命令会进离线队列（`enableOfflineQueue`），看着没报错，实际没落地。
     */
    health: () => ({
      ok: redis.status === 'ready',
      backend: 'redis',
      status: redis.status,
    }),
    close: async () => {
      await redis.quit().catch(() => undefined)
    },
    clearAll: async () => {
      const keys = await scanKeys(redis, `${options.prefix}:*`)
      if (keys.length > 0) await redis.del(...keys)
    },
  }
}
