import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { ConfigService } from '@learning/config'
import type { OnApplicationShutdown } from '@nestjs/common'
import type { ClusterBackend, ClusterHealth } from './backend.js'
import { Bus, type BusEnvelope } from './bus.js'
import { createMemoryBackend } from './memory.js'
import { type ResolvedClusterOptions, resolveClusterOptions } from './options.js'
import type { SharedLock } from './shared-lock.js'
import { type Codec, jsonCodec, type SharedChannel, type SharedMap, stringCodec } from './shared-state.js'

/**
 * 跨进程共享状态的入口，经依赖注入拿到。**类本身就是注入 token**，所以进程里只能有一份：消费者把 `@learning/cluster` 声明成 peerDependency。
 */
export class Cluster implements OnApplicationShutdown {
  private closing: Promise<void> | undefined
  /** 跨进程请求，见 {@link Bus} */
  readonly bus: Bus

  /**
   * @param instanceId 这个进程的身份，协同的 socketId 前缀和总线都用它。主机名方便排查，随机后缀保证同一台机器上的两个进程、重启前后都不撞
   * @param redisUrl `redis` 模式连的地址，可能带密码，别进日志。Hocuspocus 的 Redis 扩展要自己开连接：这里的连接是为请求路径调的（`redis.ts`），订阅和 redlock 用不了
   */
  constructor(
    readonly mode: ResolvedClusterOptions['mode'],
    private readonly backend: ClusterBackend,
    readonly instanceId = `${hostname()}-${randomUUID().slice(0, 8)}`,
    readonly redisUrl?: string,
  ) {
    this.bus = new Bus(instanceId, backend.createChannel<BusEnvelope>('bus', jsonCodec()), backend.createMap('bus-responder', stringCodec))
  }

  /** 同名 namespace 是同一把锁，模块用自己的名字隔开键 */
  createLock(namespace: string): SharedLock {
    return this.backend.createLock(namespace)
  }

  /** 同名 namespace 是同一张表 */
  createMap<V>(namespace: string, codec: Codec<V>): SharedMap<V> {
    return this.backend.createMap(namespace, codec)
  }

  createChannel<V>(namespace: string, codec: Codec<V>): SharedChannel<V> {
    return this.backend.createChannel(namespace, codec)
  }

  health(): ClusterHealth {
    return this.backend.health()
  }

  /**
   * 放在关闭流程的最后一个阶段（同 `DataAccess`）：Nest 按 onModuleDestroy → beforeApplicationShutdown → 关 HTTP → onApplicationShutdown 走，
   * 收尾中的请求可能正拿着锁续期，放不掉锁的话别的进程要白等一个 TTL。只关一次。
   * 先撤总线的登记：连接断了就撤不掉，别的进程要白等到登记过期。
   */
  onApplicationShutdown(): Promise<void> {
    this.closing ??= this.bus.close().then(() => this.backend.close())
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
  return new Cluster('redis', backend, undefined, options.url)
}
