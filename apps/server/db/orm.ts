import { MikroORM, type Options } from '@mikro-orm/core'
import { databaseUrl, dbProvider, ensureDatabaseDir } from '../config.ts'
import { ormLoggerFactory } from '../logger/db.ts'
import { entities } from './entities/index.ts'

/**
 * 按配置建一个 MikroORM 实例。连哪种库由 DB_PROVIDER / DATABASE_URL 决定（解析规则在 config.ts，
 * 只有那一份），实体定义只有一份、和库无关（见 ./entities/columns.ts）。
 *
 * **驱动一律动态 import**：这是「一个产物两种库」的前提。`@mikro-orm/sqlite` 一加载就会
 * 拉起 better-sqlite3（原生模块），`@mikro-orm/postgresql` 会拉起 pg —— 写成静态 import，
 * 连 PostgreSQL 的进程也得先把 SQLite 的原生模块 dlopen 一遍，反之亦然。两个驱动包都在
 * 产物的运行时依赖里（构建不再按库裁剪），进程只加载用得上的那一个。
 *
 * 不连库：`MikroORM.init()` 只做实体发现，第一条查询才建连接。数据库暂时不通时进程照样起得来，
 * readiness 探针（`routes/health.ts`）会如实报 not-ready —— 和 liveness / readiness 拆开的初衷一致。
 *
 * 调用方：服务端进程的单例（`apps/server/db.ts`）、结构同步入口（`./sync-cli.ts`）、
 * 以及要拿一份改过的实体集去比对结构的测试（`entities` 参数）。
 */
export async function createOrm(options: { entities?: Options['entities'] } = {}): Promise<MikroORM> {
  const base = {
    entities: options.entities ?? entities,
    // 日志走 winston，只记 SQL 文本不记参数值，见 logger/db.ts
    loggerFactory: ormLoggerFactory,
  }

  if (dbProvider === 'postgresql') {
    const { PostgreSqlDriver } = await import('@mikro-orm/postgresql')
    // 沿用 Prisma 时代的连接串写法 `...?schema=public`：pg 不认这个参数，摘出来交给 MikroORM 的 schema 选项
    const url = new URL(databaseUrl)
    const schema = url.searchParams.get('schema') || undefined
    url.searchParams.delete('schema')
    const orm = await MikroORM.init({
      ...base,
      driver: PostgreSqlDriver,
      clientUrl: url.toString(),
      ...(schema ? { schema } : {}),
    })
    return orm as unknown as MikroORM
  }

  // better-sqlite3 不会自动建目录
  ensureDatabaseDir()
  const { SqliteDriver } = await import('@mikro-orm/sqlite')
  const orm = await MikroORM.init({
    ...base,
    driver: SqliteDriver,
    dbName: databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl,
  })
  return orm as unknown as MikroORM
}
