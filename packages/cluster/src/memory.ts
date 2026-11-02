import type { ClusterBackend } from './backend.js'
import { SharedLock } from './shared-lock.js'
import { type Codec, SharedChannel, SharedMap } from './shared-state.js'

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

/** 同名 namespace 是同一份，和 Redis 上「同名键就是同一份」一致 */
export function createMemoryBackend(): ClusterBackend {
  const locks = new Map<string, MemoryLock>()
  const maps = new Map<string, Map<string, Entry>>()
  const subscribers = new Map<string, Set<RawHandler>>()
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
    createChannel: <V>(namespace: string, codec: Codec<V>) => new MemoryChannel<V>(namespace, subscribers, codec),
    health: () => ({ ok: true, backend: 'memory', status: 'ready' }),
    close: () => Promise.resolve(),
  }
}
