import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  SharedChannel,
  SharedCounter,
  SharedLock,
  SharedLog,
  SharedMap,
  type ClusterBackend,
  type Codec,
  type LogAppendOptions,
  type LogEntry,
} from './shared.ts'

/**
 * 多副本实现 —— 三个抽象各自落到 Redis 上最贴切的那个原语：
 *
 * | 抽象 | Redis |
 * |---|---|
 * | `SharedMap.get/set` | `GET` / `SET [PX]` |
 * | `SharedMap.claim` | `SET NX` —— 判断加写入必须是一个原子动作 |
 * | `SharedMap.compareAndSet` / `deleteIfEquals` | Lua（`EVAL`）—— 比较加写入 / 删除在服务端一步完成 |
 * | `SharedMap.entries` | `SCAN MATCH` + `MGET`（冷路径专用） |
 * | `SharedCounter.next` | `INCR`，键不存在时先按库里的最大值播种 |
 * | `SharedLock.run` | `SET NX PX` + 带 token 的 Lua 释放 |
 * | `SharedLog.append` / `read` / `wait` | `XADD MAXLEN` + `PEXPIRE`（MULTI）/ `XRANGE` / `XREAD BLOCK`（单独的连接） |
 * | `SharedChannel` | `PUBLISH` / `SUBSCRIBE`（订阅独占一条连接） |
 *
 * **这个模块只在 `CLUSTER_MODE=redis` 时被动态 import**（`cluster/index.ts` 的
 * `initCluster`），所以单副本进程里 ioredis 连加载都不会发生，构建产物也不带它 ——
 * 和 `apps/server/db/orm.ts` 对两个数据库驱动的处理是同一套路数。
 */

/** 释放锁：只有还持有 token 的人才删得掉，避免删掉别人续上的那把 */
const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

/**
 * 比较后写：值（编码后的字符串）相等才写。
 * ARGV[1]=expected，ARGV[2]=next，ARGV[3]=ttl 毫秒（0 = 不过期）。
 *
 * 必须在服务端一步做完：键过期后可能已被别人 claim 走，客户端先 GET 再 SET
 * 会让旧持有者把新主人的占用覆盖掉。
 */
const COMPARE_AND_SET = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  if tonumber(ARGV[3]) > 0 then
    redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])
  else
    redis.call('set', KEYS[1], ARGV[2])
  end
  return 1
end
return 0
`

/** 比较后删：值相等才删，旧持有者收尾时删不掉已经易主的键 */
const DELETE_IF_EQUALS = `
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

  async compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean> {
    const result = await this.#redis.eval(
      COMPARE_AND_SET,
      1,
      this.#full(key),
      this.codec.encode(expected),
      this.codec.encode(next),
      String(ttlMs ?? 0),
    )
    return result === 1
  }

  async deleteIfEquals(key: string, expected: V): Promise<boolean> {
    const result = await this.#redis.eval(
      DELETE_IF_EQUALS,
      1,
      this.#full(key),
      this.codec.encode(expected),
    )
    return result === 1
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

/**
 * 阻塞读最多同时占几条连接。`XREAD BLOCK` 会把整条连接堵住（同一条连接上的其它命令都得排在它后面），
 * 所以不能用主连接；每个在等的读者借一条单独的连接，用完还回池子。
 * 超过这个数（同时在跟的读者异常多）就退回**轮询**（每 {@link LOG_POLL_MS} 用主连接 `XRANGE` 一次）：
 * 慢一点，但连接数有上限 —— 不至于因为一群人同时接回就把 Redis 的连接数打满。
 */
const MAX_BLOCKING_CONNECTIONS = 16
/** 池子里最多留几条闲着的阻塞连接（多出来的用完就关） */
const MAX_IDLE_BLOCKING_CONNECTIONS = 4
const LOG_POLL_MS = 200

/** stream 条目的字段名：每条只有一个字段，值是编码后的字符串 */
const LOG_FIELD = 'v'

type StreamEntry = [id: string, fields: string[]]

class RedisLog<V> extends SharedLog<V> {
  readonly #redis: Redis
  readonly #prefix: string
  readonly #blocking: BlockingPool

  constructor(redis: Redis, blocking: BlockingPool, prefix: string, namespace: string, codec: Codec<V>) {
    super(namespace, codec)
    this.#redis = redis
    this.#blocking = blocking
    this.#prefix = `${prefix}:${namespace}:`
  }

  #full(key: string) {
    return `${this.#prefix}${key}`
  }

  #decode(entries: StreamEntry[] | null | undefined): LogEntry<V>[] {
    const out: LogEntry<V>[] = []
    for (const [id, fields] of entries ?? []) {
      const at = fields.indexOf(LOG_FIELD)
      if (at < 0 || at + 1 >= fields.length) continue
      out.push({ id, value: this.codec.decode(fields[at + 1]!) })
    }
    return out
  }

  async append(key: string, value: V, options: LogAppendOptions = {}): Promise<string> {
    const full = this.#full(key)
    const trim = options.maxLen !== undefined ? ['MAXLEN', String(options.maxLen)] : []
    // 追加和续期放在一个 MULTI 里：不会出现「写进去了、但没设上过期」的孤儿 stream
    const multi = this.#redis.multi().call('XADD', full, ...trim, '*', LOG_FIELD, this.codec.encode(value))
    if (options.ttlMs) multi.pexpire(full, options.ttlMs)
    const results = await multi.exec()
    if (!results) throw new Error(`[cluster] XADD ${full} 没有执行（事务被放弃）`)
    for (const [err] of results) if (err) throw err
    return String(results[0]![1])
  }

  async read(key: string, after: string | null, count?: number): Promise<LogEntry<V>[]> {
    const args: (string | number)[] = [this.#full(key), after === null ? '-' : `(${after}`, '+']
    if (count !== undefined) args.push('COUNT', count)
    return this.#decode((await this.#redis.call('XRANGE', ...args)) as StreamEntry[])
  }

  async wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]> {
    // 已经有了就别去借阻塞连接
    const ready = await this.read(key, after)
    if (ready.length > 0) return ready
    const conn = await this.#blocking.acquire()
    if (!conn) {
      await sleep(Math.min(Math.max(1, blockMs), LOG_POLL_MS))
      return this.read(key, after)
    }
    try {
      // 起点 `0-0` = 从头（stream 还不存在时 XREAD BLOCK 照样等它被建出来）
      const reply = (await conn.call(
        'XREAD',
        'BLOCK',
        Math.max(1, Math.floor(blockMs)),
        'STREAMS',
        this.#full(key),
        after ?? '0-0',
      )) as [string, StreamEntry[]][] | null
      return this.#decode(reply?.[0]?.[1])
    } finally {
      this.#blocking.release(conn)
    }
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.pexpire(this.#full(key), ttlMs)) === 1
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(this.#full(key))
  }
}

/** 阻塞读用的连接池（见 {@link MAX_BLOCKING_CONNECTIONS}） */
class BlockingPool {
  readonly #redis: Redis
  readonly #idle: Redis[] = []
  readonly #busy = new Set<Redis>()
  #closed = false

  constructor(redis: Redis) {
    this.#redis = redis
  }

  /** 借一条；到上限了返回 null（调用方退回轮询） */
  async acquire(): Promise<Redis | null> {
    if (this.#closed) return null
    const reused = this.#idle.pop()
    if (reused) {
      this.#busy.add(reused)
      return reused
    }
    if (this.#busy.size >= MAX_BLOCKING_CONNECTIONS) return null
    const conn = this.#redis.duplicate({ lazyConnect: true })
    conn.on('error', (err: Error) => console.error('[cluster] Redis 阻塞读连接出错', err.message))
    this.#busy.add(conn)
    try {
      await conn.connect()
    } catch (err) {
      this.#busy.delete(conn)
      conn.disconnect()
      throw err
    }
    return conn
  }

  release(conn: Redis) {
    this.#busy.delete(conn)
    if (this.#closed || conn.status !== 'ready' || this.#idle.length >= MAX_IDLE_BLOCKING_CONNECTIONS) {
      conn.disconnect()
      return
    }
    this.#idle.push(conn)
  }

  async close() {
    this.#closed = true
    for (const conn of this.#idle.splice(0)) await conn.quit().catch(() => undefined)
    // 还堵在 XREAD BLOCK 上的：直接断开，读者那边拿到一个错误
    for (const conn of this.#busy) conn.disconnect()
    this.#busy.clear()
  }
}

/**
 * 订阅端：**整个 backend 一条**专用连接（进入订阅模式的连接不能再发普通命令），按频道分发给各个 handler。
 * 第一次订阅时才建；ioredis 断线重连后会自己重新订阅（`autoResubscribe`），断线期间发的消息丢失 ——
 * 这正是 {@link SharedChannel} 声明的语义。
 */
class Subscriber {
  readonly #redis: Redis
  #conn: Promise<Redis> | null = null
  readonly #handlers = new Map<string, Set<(raw: string) => void>>()

  constructor(redis: Redis) {
    this.#redis = redis
  }

  #connection(): Promise<Redis> {
    this.#conn ??= (async () => {
      const conn = this.#redis.duplicate({ lazyConnect: true })
      conn.on('error', (err: Error) => console.error('[cluster] Redis 订阅连接出错', err.message))
      conn.on('message', (channel: string, raw: string) => {
        for (const handler of [...(this.#handlers.get(channel) ?? [])]) handler(raw)
      })
      await conn.connect()
      return conn
    })()
    return this.#conn
  }

  async subscribe(channel: string, handler: (raw: string) => void): Promise<() => Promise<void>> {
    const conn = await this.#connection()
    let set = this.#handlers.get(channel)
    if (!set) {
      set = new Set()
      this.#handlers.set(channel, set)
      await conn.subscribe(channel)
    }
    set.add(handler)
    return async () => {
      const current = this.#handlers.get(channel)
      if (!current?.delete(handler) || current.size > 0) return
      this.#handlers.delete(channel)
      await conn.unsubscribe(channel).catch(() => undefined)
    }
  }

  async close() {
    const conn = this.#conn
    this.#conn = null
    this.#handlers.clear()
    if (conn) await (await conn.catch(() => null))?.quit().catch(() => undefined)
  }
}

class RedisChannel<V> extends SharedChannel<V> {
  readonly #redis: Redis
  readonly #subscriber: Subscriber
  readonly #prefix: string

  constructor(redis: Redis, subscriber: Subscriber, prefix: string, namespace: string, codec: Codec<V>) {
    super(namespace, codec)
    this.#redis = redis
    this.#subscriber = subscriber
    this.#prefix = `${prefix}:${namespace}:`
  }

  async publish(channel: string, message: V): Promise<void> {
    await this.#redis.publish(`${this.#prefix}${channel}`, this.codec.encode(message))
  }

  subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>> {
    const name = `${this.#prefix}${channel}`
    return this.#subscriber.subscribe(name, (raw) => {
      try {
        handler(this.codec.decode(raw))
      } catch (err) {
        console.error(`[cluster] 频道 ${name} 的订阅者处理消息出错`, err)
      }
    })
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
  const blocking = new BlockingPool(redis)
  const subscriber = new Subscriber(redis)

  return {
    createMap: <V>(namespace: string, codec: Codec<V>) =>
      new RedisMap<V>(redis, options.prefix, namespace, codec),
    createCounter: (namespace: string) => new RedisCounter(redis, options.prefix, namespace),
    createLock: (namespace: string) => new RedisLock(redis, options.prefix, namespace),
    createLog: <V>(namespace: string, codec: Codec<V>) =>
      new RedisLog<V>(redis, blocking, options.prefix, namespace, codec),
    createChannel: <V>(namespace: string, codec: Codec<V>) =>
      new RedisChannel<V>(redis, subscriber, options.prefix, namespace, codec),
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
      await blocking.close()
      await subscriber.close()
      await redis.quit().catch(() => undefined)
    },
    clearAll: async () => {
      const keys = await scanKeys(redis, `${options.prefix}:*`)
      if (keys.length > 0) await redis.del(...keys)
    },
  }
}
