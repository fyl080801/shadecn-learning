import { clusterMode, isClustered, redisKeyPrefix, redisUrl } from '../config.ts'
import { createMemoryBackend } from './memory.ts'
import {
  SharedCounter,
  SharedLock,
  SharedMap,
  jsonCodec,
  type ClusterBackend,
  type Codec,
} from './shared.ts'

/**
 * 共享状态的出入口。业务模块只 import 这里的三个工厂函数，
 * 不知道背后是内存还是 Redis。
 *
 * **为什么工厂返回的是「懒代理」**：`awareness.ts`、`quota.ts` 这些模块在**顶层**
 * 就声明自己要用的表（就像以前在顶层 `new Map()` 一样），而挑实现要等
 * `initCluster()` —— 它得 `await import('ioredis')，是异步的。ES 模块的顶层代码
 * 在那之前就跑完了。所以工厂当场返回一个壳，真正的实现在**第一次被调用时**
 * 才从当前 backend 里取。换 backend（初始化、测试里重置）只要把代数 +1，
 * 壳下一次调用就会重新取，调用方一无所知。
 */

let backend: ClusterBackend = createMemoryBackend()
/** backend 换了几次；懒代理靠它判断手里缓存的实现是不是过期了 */
let generation = 0

function swapBackend(next: ClusterBackend) {
  backend = next
  generation += 1
}

/**
 * 挑实现。`server/index.ts` 在监听端口之前 await 它一次。
 *
 * 单副本模式下这函数什么也不做 —— Redis 那半连 import 都不会发生，
 * 所以构建产物里也不会出现 ioredis（`scripts/build-server.mjs` 从
 * esbuild 的 external 反推依赖，动态 import 才有资格被摘掉）。
 */
export async function initCluster(): Promise<void> {
  if (!isClustered) return

  const { createRedisBackend } = await import('./redis.ts')
  swapBackend(await createRedisBackend({ url: redisUrl, prefix: redisKeyPrefix }))
  console.log(`[cluster] 多副本模式，共享状态走 Redis（键前缀 ${redisKeyPrefix}:）`)
}

/** 进程退出时收连接。单副本下是空操作 */
export async function closeCluster(): Promise<void> {
  await backend.close()
  swapBackend(createMemoryBackend())
}

/** 测试用：换成指定 backend，返回还原函数 */
export function useBackendForTesting(next: ClusterBackend): () => void {
  const previous = backend
  swapBackend(next)
  return () => swapBackend(previous)
}

export { clusterMode }

// ---------------------------------------------------------------- 懒代理

class LazyMap<V> extends SharedMap<V> {
  #real: SharedMap<V> | null = null
  #generation = -1

  get #target(): SharedMap<V> {
    if (!this.#real || this.#generation !== generation) {
      this.#real = backend.createMap<V>(this.namespace, this.codec)
      this.#generation = generation
    }
    return this.#real
  }

  get(key: string) {
    return this.#target.get(key)
  }
  set(key: string, value: V, ttlMs?: number) {
    return this.#target.set(key, value, ttlMs)
  }
  claim(key: string, value: V, ttlMs?: number) {
    return this.#target.claim(key, value, ttlMs)
  }
  delete(key: string) {
    return this.#target.delete(key)
  }
  entries(prefix?: string) {
    return this.#target.entries(prefix)
  }
  deleteByPrefix(prefix: string) {
    return this.#target.deleteByPrefix(prefix)
  }
}

class LazyCounter extends SharedCounter {
  #real: SharedCounter | null = null
  #generation = -1

  get #target(): SharedCounter {
    if (!this.#real || this.#generation !== generation) {
      this.#real = backend.createCounter(this.namespace)
      this.#generation = generation
    }
    return this.#real
  }

  next(key: string, seed: () => Promise<number>) {
    return this.#target.next(key, seed)
  }
  forget(key: string) {
    return this.#target.forget(key)
  }
}

class LazyLock extends SharedLock {
  #real: SharedLock | null = null
  #generation = -1

  get #target(): SharedLock {
    if (!this.#real || this.#generation !== generation) {
      this.#real = backend.createLock(this.namespace)
      this.#generation = generation
    }
    return this.#real
  }

  run<T>(key: string, task: () => Promise<T>, options: { fallback: () => Promise<T>; ttlMs?: number }) {
    return this.#target.run(key, task, options)
  }
}

/**
 * 声明一张共享表。**在模块顶层调用**，就像以前写 `new Map()` 那样。
 *
 * `namespace` 是这张表的名字，会成为 Redis 的键前缀，别和别的模块重名。
 */
export function sharedMap<V>(namespace: string, codec: Codec<V> = jsonCodec<V>()): SharedMap<V> {
  return new LazyMap<V>(namespace, codec)
}

export function sharedCounter(namespace: string): SharedCounter {
  return new LazyCounter(namespace)
}

export function sharedLock(namespace: string): SharedLock {
  return new LazyLock(namespace)
}

export {
  SharedCounter,
  SharedLock,
  SharedMap,
  bytesCodec,
  jsonCodec,
  numberCodec,
  stringCodec,
  type ClusterBackend,
  type Codec,
} from './shared.ts'
export { createMemoryBackend } from './memory.ts'
