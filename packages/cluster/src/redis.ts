import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import type { ClusterBackend } from './backend.js'
import { SharedLock, SharedLockUnavailableError } from './shared-lock.js'
import { type Codec, type LogAppendOptions, type LogEntry, SharedChannel, SharedLog, SharedMap } from './shared-state.js'

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

/**
 * 比较后写。ARGV：expected、next、TTL 毫秒（0 = 不过期）。
 * 必须在服务端一步做完：键过期后可能已经易主，客户端先 GET 再 SET 会让旧持有者盖掉新主人。
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

  async compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean> {
    const result = await this.redis.eval(COMPARE_AND_SET, 1, `${this.#prefix}${key}`, this.codec.encode(expected), this.codec.encode(next), String(ttlMs ?? 0))
    return result === 1
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
 * 同时最多占几条阻塞连接。`XREAD BLOCK` 会把整条连接堵住，同一条连接上的命令都得排在它后面，所以不能用主连接。
 * 超过这个数就退回轮询：慢一点，但一群人同时接回时不会把 Redis 的连接数打满。
 */
const MAX_BLOCKING_CONNECTIONS = 16
/** 用完留着复用的连接数，多出来的直接关 */
const MAX_IDLE_BLOCKING_CONNECTIONS = 4
const LOG_POLL_INTERVAL_MS = 200
/** 排查时在 `CLIENT LIST` 里认得出来 */
const BLOCKING_CONNECTION_NAME = 'learning-cluster-log'

/** stream 条目的字段名：每条只有一个字段，值是编码后的字符串 */
const LOG_FIELD = 'v'

type StreamEntry = [id: string, fields: string[]]
type XReadReply = [stream: string, entries: StreamEntry[]][] | null

/**
 * 阻塞读用的连接池。这些连接和主连接的调法不一样，都是因为 `XREAD BLOCK` 本来就要等：
 * - 没有 `commandTimeout`：主连接的 2 秒会把每个更长的阻塞读都掐掉。放开之后对面不回话就没人管了，所以每次都有自己的看门狗，到点断开这条连接；
 * - 不重连（`retryStrategy` 返回 null）：断了立刻 `end`，命令 reject，下一次 wait 开新的。
 *   默认重连的话，`autoResendUnfulfilledCommands: false` 下断开时在等的命令可能既不重发也不 reject，等的人就永远等下去。
 *
 * 关闭时只 `disconnect` 不 `QUIT`：堵在 `XREAD` 上的连接回不了 `QUIT`，对面不回话时也回不了，等它就是拖住退出。
 */
class BlockingPool {
  readonly #idle: Redis[] = []
  /** 正在用的连接 → 让等它的人立刻收工 */
  readonly #busy = new Map<Redis, () => void>()
  /** 退回轮询、正在睡的人 */
  readonly #sleepers = new Set<() => void>()
  #closed = false

  constructor(private readonly redis: Redis) {}

  get closed(): boolean {
    return this.#closed
  }

  #takeIdle(): Redis | undefined {
    for (let conn = this.#idle.pop(); conn; conn = this.#idle.pop()) {
      if (conn.status === 'ready') return conn
      conn.disconnect()
    }
    return undefined
  }

  #open(): Redis {
    const conn = this.redis.duplicate({
      lazyConnect: true,
      commandTimeout: undefined,
      retryStrategy: () => null,
      connectionName: BLOCKING_CONNECTION_NAME,
    })
    let lastError: string | undefined
    conn.on('error', (err: Error) => {
      if (err.message === lastError) return
      lastError = err.message
      console.error(`[cluster] Redis 阻塞读连接出错：${err.message}`)
    })
    return conn
  }

  #giveBack(conn: Redis): void {
    if (this.#closed || conn.status !== 'ready' || this.#idle.length >= MAX_IDLE_BLOCKING_CONNECTIONS) conn.disconnect()
    else this.#idle.push(conn)
  }

  /** 借一条连接等一次。`full` = 到上限了，调用方退回轮询；`closed` = 等的途中关闭了。连接出错、对面不回话都 reject */
  xread(stream: string, from: string, blockMs: number): Promise<XReadReply | 'full' | 'closed'> {
    if (this.#closed) return Promise.resolve('closed')
    let conn = this.#takeIdle()
    const fresh = !conn
    if (!conn) {
      if (this.#busy.size >= MAX_BLOCKING_CONNECTIONS) return Promise.resolve('full')
      conn = this.#open()
    }
    const connection = conn

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        this.#busy.delete(connection)
        finish()
      }
      const limitMs = blockMs + COMMAND_TIMEOUT_MS + (fresh ? CONNECT_TIMEOUT_MS : 0)
      const watchdog = setTimeout(() => {
        settle(() => {
          connection.disconnect()
          reject(new Error('[cluster] Redis 阻塞读超时：对面不回话'))
        })
      }, limitMs)
      this.#busy.set(connection, () => settle(() => resolve('closed')))

      const connected = fresh ? connection.connect() : Promise.resolve()
      connected
        .then(() => connection.call('XREAD', 'BLOCK', blockMs, 'STREAMS', stream, from))
        .then(
          (reply) =>
            settle(() => {
              this.#giveBack(connection)
              resolve(reply as XReadReply)
            }),
          (err: unknown) =>
            settle(() => {
              connection.disconnect()
              reject(err instanceof Error ? err : new Error(String(err)))
            }),
        )
    })
  }

  /** 退回轮询时的睡眠，关闭时立刻醒 */
  pause(ms: number): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.#sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.#sleepers.add(wake)
    })
  }

  close(): void {
    this.#closed = true
    for (const conn of this.#idle.splice(0)) conn.disconnect()
    for (const [conn, finish] of [...this.#busy]) {
      conn.disconnect()
      finish()
    }
    for (const wake of [...this.#sleepers]) wake()
  }
}

class RedisLog<V> extends SharedLog<V> {
  readonly #prefix: string

  constructor(
    private readonly redis: Redis,
    private readonly pool: BlockingPool,
    prefix: string,
    namespace: string,
    private readonly codec: Codec<V>,
  ) {
    super()
    this.#prefix = `${prefix}:${namespace}:`
  }

  #decode(entries: StreamEntry[] | undefined): LogEntry<V>[] {
    const result: LogEntry<V>[] = []
    for (const [id, fields] of entries ?? []) {
      const at = fields.indexOf(LOG_FIELD)
      const raw = at < 0 ? undefined : fields[at + 1]
      if (raw !== undefined) result.push({ id, value: this.codec.decode(raw) })
    }
    return result
  }

  async append(key: string, value: V, options: LogAppendOptions = {}): Promise<string> {
    const full = `${this.#prefix}${key}`
    const trim = options.maxLen !== undefined ? ['MAXLEN', String(options.maxLen)] : []
    // 追加和续期放在一个 MULTI 里：不会出现写进去了却没设上过期的 stream
    const multi = this.redis.multi().call('XADD', full, ...trim, '*', LOG_FIELD, this.codec.encode(value))
    if (options.ttlMs) multi.pexpire(full, options.ttlMs)
    const results = await multi.exec()
    if (!results) throw new Error('[cluster] XADD 没有执行（事务被放弃）')
    for (const [err] of results) if (err) throw err
    return String(results[0]?.[1])
  }

  async read(key: string, after: string | null): Promise<LogEntry<V>[]> {
    return this.#decode((await this.redis.call('XRANGE', `${this.#prefix}${key}`, after === null ? '-' : `(${after}`, '+')) as StreamEntry[])
  }

  async wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]> {
    // 关闭后不能回空数组：调用方是循环，每次都立刻回空就是空转。主连接关了之后 read 也会 reject，这里挡的是关闭途中的窗口
    if (this.pool.closed) throw new Error('[cluster] 共享层已关闭')
    // 已经有了就别去借阻塞连接
    const ready = await this.read(key, after)
    if (ready.length > 0) return ready

    // BLOCK 0 是永远等，至少 1 毫秒。起点 0-0 = 从头，stream 还不存在时 XREAD BLOCK 照样等它被建出来
    const ms = Math.max(1, Math.floor(blockMs))
    const reply = await this.pool.xread(`${this.#prefix}${key}`, after ?? '0-0', ms)
    if (reply === 'closed') return []
    if (reply === 'full') return this.#poll(key, after, ms)
    return this.#decode(reply?.[0]?.[1])
  }

  /** 连接到上限时的退路：用主连接 XRANGE，同样等满 `blockMs` 才回空，否则调用方的「每等满一段查一次登记」会变成每 200 毫秒一次 */
  async #poll(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]> {
    const deadline = Date.now() + blockMs
    for (;;) {
      await this.pool.pause(Math.min(LOG_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
      if (this.pool.closed) return []
      const got = await this.read(key, after)
      if (got.length > 0 || Date.now() >= deadline) return got
    }
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.pexpire(`${this.#prefix}${key}`, ttlMs)) === 1
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
  const blocking = new BlockingPool(redis)

  return {
    createLock: (namespace) => new RedisLock(redis, KEY_PREFIX, namespace),
    createMap: <V>(namespace: string, codec: Codec<V>) => new RedisMap<V>(redis, KEY_PREFIX, namespace, codec),
    createLog: <V>(namespace: string, codec: Codec<V>) => new RedisLog<V>(redis, blocking, KEY_PREFIX, namespace, codec),
    createChannel: <V>(namespace: string, codec: Codec<V>) => new RedisChannel<V>(redis, subscriber, KEY_PREFIX, namespace, codec),
    // 读 ioredis 自己维护的状态，不发 PING。订阅连接还没建是正常的（第一次订阅才建），建了就要算上：它断了总线收不到回话。
    // 阻塞连接不算：断了的那条立刻丢弃，下一次 wait 开新的，留不下「坏着」的状态
    health: () => ({
      ok: redis.status === 'ready' && (subscriber.status === null || subscriber.status === 'ready'),
      backend: 'redis',
      status: redis.status,
    }),
    close: async () => {
      blocking.close()
      await subscriber.close()
      // quit 等服务端回话，连不上时立刻失败，黑洞时受 commandTimeout 约束。disconnect 才能停掉后台重连
      await redis.quit().catch(() => undefined)
      redis.disconnect()
    },
  }
}
