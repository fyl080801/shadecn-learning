import { EventEmitter } from 'node:events'
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
 * 进程内实现 —— 就是改造之前那些模块级 `Map`，一行逻辑都没多。
 *
 * 单副本模式下用的是它，所以「默认形态零外部依赖」这条没变：
 * 不设 REDIS_URL 就永远走这里，ioredis 连 import 都不会发生。
 *
 * TTL 这里是**惰性过期**：不起定时器，读到过期的键当作不存在并顺手删掉。
 * 反正单进程里这些表都很小（在线人数、开着的房间数量级），
 * 起一堆 setTimeout 反而是白白占着事件循环。
 */

interface Entry<V> {
  value: V
  /** 绝对过期时刻（epoch ms）；null = 不过期 */
  expiresAt: number | null
}

class MemoryMap<V> extends SharedMap<V> {
  readonly #entries = new Map<string, Entry<V>>()

  #alive(key: string): Entry<V> | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry
  }

  get(key: string): Promise<V | undefined> {
    return Promise.resolve(this.#alive(key)?.value)
  }

  set(key: string, value: V, ttlMs?: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
    return Promise.resolve()
  }

  claim(key: string, value: V, ttlMs?: number): Promise<boolean> {
    if (this.#alive(key)) return Promise.resolve(false)
    this.#entries.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
    return Promise.resolve(true)
  }

  compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean> {
    const entry = this.#alive(key)
    // 和 Redis 实现一致：比较的是编码后的字符串，对象值不能靠引用相等
    if (!entry || this.codec.encode(entry.value) !== this.codec.encode(expected)) {
      return Promise.resolve(false)
    }
    this.#entries.set(key, { value: next, expiresAt: ttlMs ? Date.now() + ttlMs : null })
    return Promise.resolve(true)
  }

  deleteIfEquals(key: string, expected: V): Promise<boolean> {
    const entry = this.#alive(key)
    if (!entry || this.codec.encode(entry.value) !== this.codec.encode(expected)) {
      return Promise.resolve(false)
    }
    this.#entries.delete(key)
    return Promise.resolve(true)
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key)
    return Promise.resolve()
  }

  entries(prefix = ''): Promise<[string, V][]> {
    const result: [string, V][] = []
    for (const key of [...this.#entries.keys()]) {
      if (!key.startsWith(prefix)) continue
      const entry = this.#alive(key)
      if (entry) result.push([key, entry.value])
    }
    return Promise.resolve(result)
  }

  deleteByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key)
    }
    return Promise.resolve()
  }
}

class MemoryCounter extends SharedCounter {
  /** key → 已经发出去的最大号 */
  readonly #used = new Map<string, number>()
  /** 同一个键的并发播种合并成一次，别对着库查两遍 */
  readonly #seeding = new Map<string, Promise<number>>()

  async next(key: string, seed: () => Promise<number>): Promise<number> {
    let used = this.#used.get(key)

    if (used === undefined) {
      let pending = this.#seeding.get(key)
      if (!pending) {
        pending = seed().finally(() => this.#seeding.delete(key))
        this.#seeding.set(key, pending)
      }
      const seeded = await pending
      // 播种期间可能已经有人先发过号了，取大的那个，别把号退回去
      used = Math.max(this.#used.get(key) ?? 0, seeded)
    }

    const next = used + 1
    this.#used.set(key, next)
    return next
  }

  forget(key: string): Promise<void> {
    this.#used.delete(key)
    return Promise.resolve()
  }
}

class MemoryLock extends SharedLock {
  readonly #inflight = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>, options: { fallback: () => Promise<T> }): Promise<T> {
    const running = this.#inflight.get(key)
    // 进程内不需要 fallback：直接复用同一个 promise，后来者拿到的就是赢家的结果
    if (running) return running as Promise<T>
    void options

    const started = task().finally(() => {
      if (this.#inflight.get(key) === started) this.#inflight.delete(key)
    })
    this.#inflight.set(key, started)
    return started
  }
}

/** 一份日志：条目存的是**编码后的字符串**（和 Redis 一样，读出来是新对象，不会和写的一方共享引用） */
interface MemoryLogState {
  entries: { id: number; raw: string }[]
  expiresAt: number | null
  /** 等新条目的人：追加时全部叫醒 */
  waiters: Set<() => void>
}

/**
 * 一个 backend 里全部日志 / 频道的状态。按 `namespace` 共享 —— 和 Redis 上「同名键就是同一份」一致，
 * 测试里两个「副本」各 `createLog` 一次也读写同一份。
 */
interface MemoryShared {
  logs: Map<string, MemoryLogState>
  /** 日志 id 的发号器：整个 backend 单调递增，日志过期后重建也不会发出比旧游标小的号 */
  nextLogId: number
  bus: EventEmitter
}

class MemoryLog<V> extends SharedLog<V> {
  readonly #shared: MemoryShared

  constructor(shared: MemoryShared, namespace: string, codec: Codec<V>) {
    super(namespace, codec)
    this.#shared = shared
  }

  #full(key: string) {
    return `${this.namespace}:${key}`
  }

  /** 活着的那份；过期的当作不存在并删掉（惰性过期，同 MemoryMap）。等着的人留着：之后重建的日志照样叫醒它们 */
  #alive(key: string): MemoryLogState | undefined {
    const state = this.#shared.logs.get(this.#full(key))
    if (!state) return undefined
    if (state.expiresAt !== null && state.expiresAt <= Date.now()) {
      if (state.waiters.size === 0) this.#shared.logs.delete(this.#full(key))
      else {
        state.entries = []
        state.expiresAt = null
      }
      return state.waiters.size === 0 ? undefined : state
    }
    return state
  }

  #after(state: MemoryLogState | undefined, after: string | null, count?: number): LogEntry<V>[] {
    if (!state) return []
    const from = after === null ? -Infinity : Number(after)
    const picked = state.entries.filter((entry) => entry.id > from)
    return (count === undefined ? picked : picked.slice(0, count)).map((entry) => ({
      id: String(entry.id),
      value: this.codec.decode(entry.raw),
    }))
  }

  append(key: string, value: V, options: LogAppendOptions = {}): Promise<string> {
    let state = this.#alive(key)
    if (!state) {
      state = { entries: [], expiresAt: null, waiters: new Set() }
      this.#shared.logs.set(this.#full(key), state)
    }
    this.#shared.nextLogId += 1
    const id = this.#shared.nextLogId
    state.entries.push({ id, raw: this.codec.encode(value) })
    if (options.maxLen !== undefined && state.entries.length > options.maxLen) {
      state.entries.splice(0, state.entries.length - options.maxLen)
    }
    if (options.ttlMs) state.expiresAt = Date.now() + options.ttlMs
    const waiters = [...state.waiters]
    state.waiters.clear()
    for (const wake of waiters) wake()
    return Promise.resolve(String(id))
  }

  read(key: string, after: string | null, count?: number): Promise<LogEntry<V>[]> {
    return Promise.resolve(this.#after(this.#alive(key), after, count))
  }

  wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]> {
    const ready = this.#after(this.#alive(key), after)
    if (ready.length > 0) return Promise.resolve(ready)
    let state = this.#alive(key)
    if (!state) {
      // 还没人写过：先占一个空壳挂等待者（append 会往同一份里写）
      state = { entries: [], expiresAt: null, waiters: new Set() }
      this.#shared.logs.set(this.#full(key), state)
    }
    const target = state
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        target.waiters.delete(wake)
        resolve(this.#after(this.#alive(key), after))
      }
      const timer = setTimeout(() => {
        target.waiters.delete(wake)
        // 没等到：空壳也别留着（没有条目、没有等待者的那份）
        if (target.entries.length === 0 && target.waiters.size === 0 && this.#shared.logs.get(this.#full(key)) === target) {
          this.#shared.logs.delete(this.#full(key))
        }
        resolve([])
      }, Math.max(1, blockMs))
      target.waiters.add(wake)
    })
  }

  expire(key: string, ttlMs: number): Promise<boolean> {
    const state = this.#alive(key)
    if (!state || state.entries.length === 0) return Promise.resolve(false)
    state.expiresAt = Date.now() + ttlMs
    return Promise.resolve(true)
  }

  delete(key: string): Promise<void> {
    const state = this.#shared.logs.get(this.#full(key))
    if (state) {
      state.entries = []
      state.expiresAt = null
      if (state.waiters.size === 0) this.#shared.logs.delete(this.#full(key))
    }
    return Promise.resolve()
  }
}

class MemoryChannel<V> extends SharedChannel<V> {
  readonly #bus: EventEmitter

  constructor(bus: EventEmitter, namespace: string, codec: Codec<V>) {
    super(namespace, codec)
    this.#bus = bus
  }

  publish(channel: string, message: V): Promise<void> {
    const raw = this.codec.encode(message)
    // 异步投递（和 Redis 一样）：发送方不会在 publish 里被订阅者的处理逻辑重入
    queueMicrotask(() => this.#bus.emit(`${this.namespace}:${channel}`, raw))
    return Promise.resolve()
  }

  subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>> {
    const name = `${this.namespace}:${channel}`
    const listener = (raw: string) => {
      try {
        handler(this.codec.decode(raw))
      } catch (err) {
        console.error(`[cluster] 频道 ${name} 的订阅者处理消息出错`, err)
      }
    }
    this.#bus.on(name, listener)
    return Promise.resolve(async () => {
      this.#bus.off(name, listener)
    })
  }
}

export function createMemoryBackend(): ClusterBackend {
  const bus = new EventEmitter()
  // 订阅者的个数没有意义上的上限（每个副本 / 每个测试一个），别让 Node 打「可能泄漏」的警告
  bus.setMaxListeners(0)
  const shared: MemoryShared = { logs: new Map(), nextLogId: 0, bus }
  return {
    createMap: <V>(namespace: string, codec: Codec<V>) => new MemoryMap<V>(namespace, codec),
    createCounter: (namespace: string) => new MemoryCounter(namespace),
    createLock: (namespace: string) => new MemoryLock(namespace),
    createLog: <V>(namespace: string, codec: Codec<V>) => new MemoryLog<V>(shared, namespace, codec),
    createChannel: <V>(namespace: string, codec: Codec<V>) => new MemoryChannel<V>(bus, namespace, codec),
    close: () => Promise.resolve(),
    // 单副本下「共享层」就是这个进程的内存：它挂了，进程也就挂了
    health: () => ({ ok: true, backend: 'memory', status: 'ready' }),
  }
}
