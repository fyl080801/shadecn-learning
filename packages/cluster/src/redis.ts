import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import type { ClusterBackend } from './backend.js'
import { SharedLock, SharedLockUnavailableError } from './shared-lock.js'
import { type Codec, SharedChannel, SharedMap } from './shared-state.js'

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
  readonly #prefix: string

  constructor(
    private readonly redis: Redis,
    prefix: string,
    namespace: string,
    private readonly codec: Codec<V>,
  ) {
    super()
    this.#prefix = `${prefix}:${namespace}:`
  }

  async get(key: string): Promise<V | undefined> {
    const raw = await this.redis.get(`${this.#prefix}${key}`)
    return raw === null ? undefined : this.codec.decode(raw)
  }

  async set(key: string, value: V, ttlMs?: number): Promise<void> {
    const full = `${this.#prefix}${key}`
    const raw = this.codec.encode(value)
    if (ttlMs) await this.redis.set(full, raw, 'PX', ttlMs)
    else await this.redis.set(full, raw)
  }

  async claim(key: string, value: V, ttlMs?: number): Promise<boolean> {
    const full = `${this.#prefix}${key}`
    const raw = this.codec.encode(value)
    const result = ttlMs ? await this.redis.set(full, raw, 'PX', ttlMs, 'NX') : await this.redis.set(full, raw, 'NX')
    return result === 'OK'
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.#prefix}${key}`)
  }

  async deleteIfEquals(key: string, expected: V): Promise<boolean> {
    return (await this.redis.eval(RELEASE_LOCK, 1, `${this.#prefix}${key}`, this.codec.encode(expected))) === 1
  }

  async entries(prefix = ''): Promise<[string, V][]> {
    const keys = await scanKeys(this.redis, `${this.#prefix}${prefix}*`)
    if (keys.length === 0) return []
    const values = await this.redis.mget(keys)
    const result: [string, V][] = []
    keys.forEach((key, index) => {
      const raw = values[index]
      // 扫到和读到之间可能刚好过期
      if (raw !== null && raw !== undefined) result.push([key.slice(this.#prefix.length), this.codec.decode(raw)])
    })
    return result
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const keys = await scanKeys(this.redis, `${this.#prefix}${prefix}*`)
    if (keys.length > 0) await this.redis.del(...keys)
  }
}

/**
 * 订阅专用的连接：进入订阅模式的连接不能发普通命令，所以一个进程一条，第一次订阅才建。
 * 断线重连后由 ioredis 自动重新订阅（`autoResubscribe`，测试钉着）；断开期间发的消息丢失，这是 `SharedChannel` 的语义。
 */
class Subscriber {
  #connection: Promise<Redis> | null = null
  readonly #handlers = new Map<string, Set<(raw: string) => void>>()
  readonly #subscribing = new Map<string, Promise<unknown>>()

  constructor(private readonly redis: Redis) {}

  get status(): string | null {
    return this.#client?.status ?? null
  }

  #client: Redis | null = null

  #connect(): Promise<Redis> {
    this.#connection ??= (async () => {
      const client = this.redis.duplicate({ lazyConnect: true })
      let lastError: string | undefined
      client.on('error', (err: Error) => {
        if (err.message === lastError) return
        lastError = err.message
        console.error(`[cluster] Redis 订阅连接出错：${err.message}`)
      })
      client.on('ready', () => (lastError = undefined))
      client.on('message', (channel: string, raw: string) => {
        for (const handler of [...(this.#handlers.get(channel) ?? [])]) handler(raw)
      })
      try {
        await client.connect()
      } catch (err) {
        client.disconnect()
        this.#connection = null
        throw err
      }
      this.#client = client
      return client
    })()
    return this.#connection
  }

  async subscribe(channel: string, handler: (raw: string) => void): Promise<() => Promise<void>> {
    const client = await this.#connect()
    let handlers = this.#handlers.get(channel)
    if (!handlers) this.#handlers.set(channel, (handlers = new Set()))
    handlers.add(handler)
    try {
      // 同一个频道的并发订阅共用一次：后来者也要等服务端确认，否则紧接着的 publish 会丢
      let subscribing = this.#subscribing.get(channel)
      if (!subscribing) {
        subscribing = client.subscribe(channel)
        this.#subscribing.set(channel, subscribing)
      }
      await subscribing
    } catch (err) {
      // 不留半截状态：handler 留着的话下次订阅以为频道已经订上了，消息却永远收不到
      this.#subscribing.delete(channel)
      handlers.delete(handler)
      if (handlers.size === 0) this.#handlers.delete(channel)
      throw err
    }
    return async () => {
      const current = this.#handlers.get(channel)
      if (!current?.delete(handler) || current.size > 0) return
      this.#handlers.delete(channel)
      this.#subscribing.delete(channel)
      await client.unsubscribe(channel).catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const client = this.#client
    this.#client = null
    this.#connection = null
    this.#handlers.clear()
    this.#subscribing.clear()
    if (!client) return
    await client.quit().catch(() => undefined)
    client.disconnect()
  }
}

class RedisChannel<V> extends SharedChannel<V> {
  readonly #prefix: string

  constructor(
    private readonly redis: Redis,
    private readonly subscriber: Subscriber,
    prefix: string,
    namespace: string,
    private readonly codec: Codec<V>,
  ) {
    super()
    this.#prefix = `${prefix}:${namespace}:`
  }

  async publish(channel: string, message: V): Promise<void> {
    await this.redis.publish(`${this.#prefix}${channel}`, this.codec.encode(message))
  }

  subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>> {
    const full = `${this.#prefix}${channel}`
    return this.subscriber.subscribe(full, (raw) => {
      try {
        handler(this.codec.decode(raw))
      } catch (err) {
        console.error(`[cluster] 频道 ${full} 的订阅者处理消息出错`, err)
      }
    })
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

  const subscriber = new Subscriber(redis)

  return {
    createLock: (namespace) => new RedisLock(redis, KEY_PREFIX, namespace),
    createMap: <V>(namespace: string, codec: Codec<V>) => new RedisMap<V>(redis, KEY_PREFIX, namespace, codec),
    createChannel: <V>(namespace: string, codec: Codec<V>) => new RedisChannel<V>(redis, subscriber, KEY_PREFIX, namespace, codec),
    // 读 ioredis 自己维护的状态，不发 PING。订阅连接还没建是正常的（第一次订阅才建），建了就要算上：它断了总线收不到回话
    health: () => ({
      ok: redis.status === 'ready' && (subscriber.status === null || subscriber.status === 'ready'),
      backend: 'redis',
      status: redis.status,
    }),
    close: async () => {
      await subscriber.close()
      // quit 等服务端回话，连不上时立刻失败，黑洞时受 commandTimeout 约束。disconnect 才能停掉后台重连
      await redis.quit().catch(() => undefined)
      redis.disconnect()
    },
  }
}
