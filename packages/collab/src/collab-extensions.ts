import type { Cluster } from '@learning/cluster'
import type { Extension } from '@hocuspocus/server'

/** Hocuspocus 扩展列表的注入 token。工厂是异步的，`CollabServer` 拿到时扩展已经建好，不用事后 `configure` */
export const COLLAB_EXTENSIONS = Symbol('COLLAB_EXTENSIONS')

/** 和 `@learning/cluster` 的键同一个前缀下：一台 Redis 上可能还有 `apps/server` 的键（`shadecn:hp`），两边的数据不互通 */
const HOCUSPOCUS_KEY_PREFIX = 'learning:hp'

/**
 * 落库那把 redlock 的持有时长。默认只有 1 秒，而一次落库要读库、合并、写回，文档大一点、库慢一点就超过了，另一个副本接着写同一行。
 * 它只是减少撞车：真撞上了由 `FlowPersistence` 的读 → 合并 → CAS 兜底，Redis 整个挂掉时也一样。
 */
const STORE_LOCK_TTL_MS = 10_000

/** 连接串 → ioredis 的选项。`URL` 里的用户名和密码是编码过的，host 里的 IPv6 带方括号 */
export function redisClientOptions(redisUrl: string) {
  const url = new URL(redisUrl)
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 6379),
    options: {
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: Number(url.pathname.slice(1)) || 0,
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    },
  }
}

/**
 * 多副本要的 Hocuspocus 扩展：更新和 awareness 经 pub/sub 转发、`afterLoadDocument` 等别的副本把内存里的状态推过来、落库 redlock。
 * 没有 Redis 就是空列表。**动态 import**：`single` 模式连这个包带 ioredis 都不加载。
 */
export async function createCollabExtensions(cluster: Pick<Cluster, 'redisUrl' | 'instanceId'>): Promise<Extension[]> {
  if (!cluster.redisUrl) return []
  const { Redis } = await import('@hocuspocus/extension-redis')

  /**
   * Redis 连不上时不抢锁，直接落库。抢的话命令先在离线队列里排满重试（实测约 50 秒），再被 redlock 报成「别的实例正在存」跳过，这段时间的内容只在内存里，健康检查也看不出欠账。
   * 锁只是优化：共享层故障 fail-open，并发由读 → 合并 → CAS 兜着。没抢锁时 `afterStoreDocument` 没有要放的锁，什么也不做。
   */
  class FailOpenRedis extends Redis {
    override async onStoreDocument(data: Parameters<InstanceType<typeof Redis>['onStoreDocument']>[0]): Promise<void> {
      if (this.pub.status === 'ready') await super.onStoreDocument(data)
    }
  }

  return [
    new FailOpenRedis({
      ...redisClientOptions(cluster.redisUrl),
      // 它是「这条消息是不是我自己发的」的判据，必须真的唯一
      identifier: cluster.instanceId,
      prefix: HOCUSPOCUS_KEY_PREFIX,
      lockTimeout: STORE_LOCK_TTL_MS,
    }),
  ]
}
