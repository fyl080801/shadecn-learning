import type { ConfigService } from '@learning/config'
import type { OnApplicationShutdown } from '@nestjs/common'
import type { ClusterBackend } from './backend.js'
import { createMemoryBackend } from './memory.js'
import { type ResolvedClusterOptions, resolveClusterOptions } from './options.js'
import type { SharedLock } from './shared-lock.js'

/**
 * 跨进程共享状态的入口，经依赖注入拿到。**类本身就是注入 token**，所以进程里只能有一份：消费者把 `@learning/cluster` 声明成 peerDependency。
 */
export class Cluster implements OnApplicationShutdown {
  private closing: Promise<void> | undefined

  constructor(
    readonly mode: ResolvedClusterOptions['mode'],
    private readonly backend: ClusterBackend,
  ) {}

  /** 同名 namespace 是同一把锁，模块用自己的名字隔开键 */
  createLock(namespace: string): SharedLock {
    return this.backend.createLock(namespace)
  }

  /**
   * 放在关闭流程的最后一个阶段（同 `DataAccess`）：Nest 按 onModuleDestroy → beforeApplicationShutdown → 关 HTTP → onApplicationShutdown 走，
   * 收尾中的请求可能正拿着锁续期，放不掉锁的话别的进程要白等一个 TTL。只关一次。
   */
  onApplicationShutdown(): Promise<void> {
    this.closing ??= this.backend.close()
    return this.closing
  }
}

/** Redis 那半动态 import：`single` 模式连 ioredis 都不加载 */
export async function openCluster(config: ConfigService): Promise<Cluster> {
  const options = resolveClusterOptions(config)
  if (options.mode === 'single') return new Cluster('single', createMemoryBackend())

  const { createRedisBackend } = await import('./redis.js')
  const backend = await createRedisBackend(options.url)
  console.log('[cluster] 多进程模式，共享状态走 Redis')
  return new Cluster('redis', backend)
}
