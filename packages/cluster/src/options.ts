import type { ConfigService } from '@learning/config'

export type ResolvedClusterOptions = { mode: 'single' } | { mode: 'redis'; url: string }

const REDIS_URL_ENV = 'PLATFORM_REDIS_URL'

/** 地址：运行目录 .env（或环境变量）优先，带密码的放那里；否则 `cluster.url`。错误信息都不带值：里面可能有密码 */
function redisUrl(config: ConfigService, section: Record<string, unknown>): string | undefined {
  const url = config.env(REDIS_URL_ENV) ?? section.url
  if (url === undefined || url === null) return undefined
  if (typeof url !== 'string') throw new Error('[cluster] cluster.url 必须是字符串')
  const trimmed = url.trim()
  if (!trimmed) return undefined
  if (!/^rediss?:\/\//i.test(trimmed)) throw new Error('[cluster] Redis 地址必须是 redis:// 或 rediss:// 开头')
  return trimmed
}

/**
 * config.yaml 的 `cluster` 段。`mode` 不写时按有没有地址推断。
 * 说要 `redis` 却没有地址是配置自相矛盾，任何环境都拒绝启动；`single` 配了地址以 `mode` 为准（临时切回单进程时不用删地址）。
 */
export function resolveClusterOptions(config: ConfigService): ResolvedClusterOptions {
  const section = config.mapping('cluster')
  const url = redisUrl(config, section)
  const mode = section.mode ?? (url ? 'redis' : 'single')
  if (mode === 'single') return { mode }
  if (mode !== 'redis') throw new Error('[cluster] cluster.mode 只能是 single 或 redis')
  if (!url) throw new Error(`[cluster] cluster.mode 是 redis，但没有地址（运行目录 .env 的 ${REDIS_URL_ENV} 或 cluster.url）`)
  return { mode, url }
}

/**
 * 多进程要共用同一个库，而 SQLite 是本机文件：`redis` 配 SQLite 时每个进程各有一份库，会话互相看不见，锁也失去了意义。
 * 生产环境拒绝启动；开发环境只警告，单进程 + 本地 Redis 是验证这条链路的合法办法。
 *
 * **本包不依赖 `@learning/data-access`**：数据库类型由应用传进来（`apps/platform` 的 `ClusterDatabaseCheckModule`），规则留在这里，接线在应用，同 `WEB_PAGE_AUTH`。
 */
export function assertClusterDatabase(input: {
  mode: ResolvedClusterOptions['mode']
  isProduction: boolean
  databaseProvider: string | undefined
}): void {
  if (input.mode !== 'redis' || input.databaseProvider !== 'sqlite') return
  const message = '[cluster] cluster.mode 是 redis，数据库却是 SQLite：多个进程各有一份库'
  if (input.isProduction) throw new Error(`${message}，生产环境拒绝启动`)
  console.warn(`${message}，开发环境只警告`)
}
