import type { ClusterBackend } from './backend.js'
import { SharedLock } from './shared-lock.js'
import { type Codec, type LogAppendOptions, type LogEntry, SharedChannel, SharedLog, SharedMap } from './shared-state.js'

class MemoryLock extends SharedLock {
  readonly #inflight = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    // 只有一个进程，不需要 fallback：直接复用同一个 promise，后来者拿到的就是赢家的结果
    const running = this.#inflight.get(key)
    if (running) return running as Promise<T>

    const started = task().finally(() => {
      if (this.#inflight.get(key) === started) this.#inflight.delete(key)
    })
    this.#inflight.set(key, started)
    return started
  }
}

interface Entry {
  raw: string
  /** 绝对过期时刻（epoch ms）；null = 不过期 */
  expiresAt: number | null
}

/** TTL 是惰性过期：不起定时器，读到过期的键当作不存在并顺手删掉 */
class MemoryMap<V> extends SharedMap<V> {
  constructor(
    private readonly store: Map<string, Entry>,
    private readonly codec: Codec<V>,
  ) {
    super()
  }

  private alive(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  private write(key: string, value: V, ttlMs?: number) {
    this.store.set(key, { raw: this.codec.encode(value), expiresAt: ttlMs ? Date.now() + ttlMs : null })
  }

  get(key: string): Promise<V | undefined> {
    const entry = this.alive(key)
    return Promise.resolve(entry ? this.codec.decode(entry.raw) : undefined)
  }

  set(key: string, value: V, ttlMs?: number): Promise<void> {
    this.write(key, value, ttlMs)
    return Promise.resolve()
  }

  claim(key: string, value: V, ttlMs?: number): Promise<boolean> {
    if (this.alive(key)) return Promise.resolve(false)
    this.write(key, value, ttlMs)
    return Promise.resolve(true)
  }

  compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean> {
    if (this.alive(key)?.raw !== this.codec.encode(expected)) return Promise.resolve(false)
    this.write(key, next, ttlMs)
    return Promise.resolve(true)
  }

  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }

  deleteIfEquals(key: string, expected: V): Promise<boolean> {
    if (this.alive(key)?.raw !== this.codec.encode(expected)) return Promise.resolve(false)
    this.store.delete(key)
    return Promise.resolve(true)
  }

  entries(prefix = ''): Promise<[string, V][]> {
    const result: [string, V][] = []
    for (const key of [...this.store.keys()]) {
      if (!key.startsWith(prefix)) continue
      const entry = this.alive(key)
      if (entry) result.push([key, this.codec.decode(entry.raw)])
    }
    return Promise.resolve(result)
  }

  deleteByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
    return Promise.resolve()
  }
}

/** 一份日志。条目存编码后的字符串，读出来是新对象（同 Redis） */
export interface MemoryLogState {
  entries: { id: number; raw: string }[]
  /** 绝对过期时刻（epoch ms）；null = 不过期 */
  expiresAt: number | null
}

/** 一个 backend 里全部日志的状态，按 namespace 共享 */
interface MemoryLogHub {
  logs: Map<string, MemoryLogState>
  /** 等新条目的人，和日志分开放：日志过期、重建都不影响它们 */
  waiters: Map<string, Set<() => void>>
  /** 整个 backend 一个发号器：日志过期重建后不会发出比旧游标小的号 */
  nextId: number
  closed: boolean
}

class MemoryLog<V> extends SharedLog<V> {
  constructor(
    private readonly hub: MemoryLogHub,
    private readonly namespace: string,
    private readonly codec: Codec<V>,
  ) {
    super()
  }

  private alive(full: string): MemoryLogState | undefined {
    const state = this.hub.logs.get(full)
    if (state && state.expiresAt !== null && state.expiresAt <= Date.now()) {
      this.hub.logs.delete(full)
      return undefined
    }
    return state
  }

  private after(full: string, after: string | null): LogEntry<V>[] {
    const from = after === null ? -Infinity : Number(after)
    const picked = (this.alive(full)?.entries ?? []).filter((entry) => entry.id > from)
    return picked.map((entry) => ({ id: String(entry.id), value: this.codec.decode(entry.raw) }))
  }

  /** 日志没人删，只靠 TTL：读的人走了就再没人碰到它。`single` 是常驻进程，新建时顺手清掉过期的，否则每一轮都留下一份 */
  private sweepExpired(): void {
    const now = Date.now()
    for (const [full, state] of this.hub.logs) {
      if (state.expiresAt !== null && state.expiresAt <= now) this.hub.logs.delete(full)
    }
  }

  append(key: string, value: V, options: LogAppendOptions = {}): Promise<string> {
    const full = `${this.namespace}:${key}`
    let state = this.alive(full)
    if (!state) {
      this.sweepExpired()
      state = { entries: [], expiresAt: null }
      this.hub.logs.set(full, state)
    }
    this.hub.nextId += 1
    state.entries.push({ id: this.hub.nextId, raw: this.codec.encode(value) })
    if (options.maxLen !== undefined && state.entries.length > options.maxLen) {
      state.entries.splice(0, state.entries.length - options.maxLen)
    }
    if (options.ttlMs) state.expiresAt = Date.now() + options.ttlMs
    for (const wake of [...(this.hub.waiters.get(full) ?? [])]) wake()
    return Promise.resolve(String(this.hub.nextId))
  }

  read(key: string, after: string | null): Promise<LogEntry<V>[]> {
    return Promise.resolve(this.after(`${this.namespace}:${key}`, after))
  }

  wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]> {
    // 关闭后不能回空数组：调用方是循环，每次都立刻回空就是一个不让出事件循环的死循环
    if (this.hub.closed) return Promise.reject(new Error('[cluster] 共享层已关闭'))
    const full = `${this.namespace}:${key}`
    const ready = this.after(full, after)
    if (ready.length > 0) return Promise.resolve(ready)

    return new Promise((resolve) => {
      let set = this.hub.waiters.get(full)
      if (!set) this.hub.waiters.set(full, (set = new Set()))
      const waiting = set
      const finish = () => {
        clearTimeout(timer)
        waiting.delete(finish)
        if (waiting.size === 0 && this.hub.waiters.get(full) === waiting) this.hub.waiters.delete(full)
        resolve(this.after(full, after))
      }
      const timer = setTimeout(finish, Math.max(1, Math.floor(blockMs)))
      waiting.add(finish)
    })
  }

  expire(key: string, ttlMs: number): Promise<boolean> {
    const state = this.alive(`${this.namespace}:${key}`)
    if (!state) return Promise.resolve(false)
    state.expiresAt = Date.now() + ttlMs
    return Promise.resolve(true)
  }
}

type RawHandler = (raw: string) => void

class MemoryChannel<V> extends SharedChannel<V> {
  constructor(
    private readonly namespace: string,
    private readonly subscribers: Map<string, Set<RawHandler>>,
    private readonly codec: Codec<V>,
  ) {
    super()
  }

  publish(channel: string, message: V): Promise<void> {
    const raw = this.codec.encode(message)
    // 异步投递，和 Redis 一样：publish 兑现时订阅者不一定已经收到
    for (const handler of [...(this.subscribers.get(`${this.namespace}:${channel}`) ?? [])]) setImmediate(handler, raw)
    return Promise.resolve()
  }

  subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>> {
    const full = `${this.namespace}:${channel}`
    const raw: RawHandler = (value) => {
      try {
        handler(this.codec.decode(value))
      } catch (err) {
        console.error(`[cluster] 频道 ${full} 的订阅者处理消息出错`, err)
      }
    }
    let set = this.subscribers.get(full)
    if (!set) this.subscribers.set(full, (set = new Set()))
    set.add(raw)
    return Promise.resolve(() => {
      set.delete(raw)
      return Promise.resolve()
    })
  }
}

/**
 * 同名 namespace 是同一份，和 Redis 上「同名键就是同一份」一致。
 * @param logs 日志的存放处。只有测试传，用来看过期的日志有没有清掉
 */
export function createMemoryBackend(logs = new Map<string, MemoryLogState>()): ClusterBackend {
  const locks = new Map<string, MemoryLock>()
  const maps = new Map<string, Map<string, Entry>>()
  const subscribers = new Map<string, Set<RawHandler>>()
  const hub: MemoryLogHub = { logs, waiters: new Map(), nextId: 0, closed: false }
  return {
    createLock(namespace) {
      let lock = locks.get(namespace)
      if (!lock) {
        lock = new MemoryLock(namespace)
        locks.set(namespace, lock)
      }
      return lock
    },
    createMap<V>(namespace: string, codec: Codec<V>) {
      let store = maps.get(namespace)
      if (!store) maps.set(namespace, (store = new Map()))
      return new MemoryMap<V>(store, codec)
    },
    createLog: <V>(namespace: string, codec: Codec<V>) => new MemoryLog<V>(hub, namespace, codec),
    createChannel: <V>(namespace: string, codec: Codec<V>) => new MemoryChannel<V>(namespace, subscribers, codec),
    health: () => ({ ok: true, backend: 'memory', status: 'ready' }),
    // 叫醒还在等的 wait：定时器不清的话，进程要等到 blockMs 到点才退得出去
    close: () => {
      hub.closed = true
      for (const waiting of [...hub.waiters.values()]) for (const wake of [...waiting]) wake()
      return Promise.resolve()
    },
  }
}
