import type { SharedLock } from './shared-lock.js'
import type { Codec, SharedChannel, SharedMap } from './shared-state.js'

/** 共享层的健康快照。同步、不发网络请求：健康检查不能因为 Redis 慢就跟着卡住 */
export interface ClusterHealth {
  /** 现在能用吗。内存实现恒为 true */
  ok: boolean
  backend: 'memory' | 'redis'
  /** 后端自己报的状态，排查用（ioredis 的 `ready` / `connecting` / `end` …） */
  status: string
}

/** 共享结构的一种实现 */
export interface ClusterBackend {
  createLock(namespace: string): SharedLock
  createMap<V>(namespace: string, codec: Codec<V>): SharedMap<V>
  createChannel<V>(namespace: string, codec: Codec<V>): SharedChannel<V>
  health(): ClusterHealth
  close(): Promise<void>
}
