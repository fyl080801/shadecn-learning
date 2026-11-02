import type { MikroORM, Options } from '@mikro-orm/core'
import { openOrm } from '@shadecn/server-kit/orm'
import { databaseUrl, dbProvider } from '../config.ts'
import { ormLoggerFactory } from '../logger/db.ts'

/**
 * 按配置建一个 MikroORM 实例。连哪种库由 DATABASE_PROVIDER / DATABASE_URL 决定（解析规则在 config.ts，
 * 只有那一份），实体定义只有一份、和库无关（规矩见 `@shadecn/server-kit/db`）。实体由调用方交进来（底座的 + 模块清单里各模块声明的，`../server.ts` 的 `serverEntities`）。
 * 驱动怎么加载、连接串怎么拆在 `@shadecn/server-kit/orm`，这里只负责读配置、接上日志（走 winston，只记 SQL 文本不记参数值，见 logger/db.ts）。
 *
 * 不连库：`MikroORM.init()` 只做实体发现，第一条查询才建连接。数据库暂时不通时进程照样起得来，
 * readiness 探针（`routes/health.ts`）会如实报 not-ready —— 和 liveness / readiness 拆开的初衷一致。
 *
 * 调用方：服务端进程的单例（`../db.ts` 的 `initDatabase`）、结构同步入口（`./sync-cli.ts`）、
 * 以及要拿一份改过的实体集去比对结构的测试（`entities` 参数）。
 */
export function createOrm(options: { entities: NonNullable<Options['entities']> }): Promise<MikroORM> {
  return openOrm({
    provider: dbProvider,
    url: databaseUrl,
    entities: options.entities,
    loggerFactory: ormLoggerFactory,
  })
}
