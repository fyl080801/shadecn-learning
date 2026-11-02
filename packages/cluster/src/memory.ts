import type { ClusterBackend } from './backend.js'
import { SharedLock } from './shared-lock.js'

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

/** 同名 namespace 拿到同一把锁，和 Redis 上「同名键就是同一份」一致 */
export function createMemoryBackend(): ClusterBackend {
  const locks = new Map<string, MemoryLock>()
  return {
    createLock(namespace) {
      let lock = locks.get(namespace)
      if (!lock) {
        lock = new MemoryLock(namespace)
        locks.set(namespace, lock)
      }
      return lock
    },
    close: () => Promise.resolve(),
  }
}
