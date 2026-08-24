import {
  SharedCounter,
  SharedLock,
  SharedMap,
  type ClusterBackend,
  type Codec,
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

export function createMemoryBackend(): ClusterBackend {
  return {
    createMap: <V>(namespace: string, codec: Codec<V>) => new MemoryMap<V>(namespace, codec),
    createCounter: (namespace: string) => new MemoryCounter(namespace),
    createLock: (namespace: string) => new MemoryLock(namespace),
    close: () => Promise.resolve(),
    // 单副本下「共享层」就是这个进程的内存：它挂了，进程也就挂了
    health: () => ({ ok: true, backend: 'memory', status: 'ready' }),
  }
}
