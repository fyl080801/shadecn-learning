import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { MikroORM, type Options } from '@mikro-orm/core'

/**
 * 建 MikroORM 实例 —— 只认调用方交进来的 provider / 连接串 / 实体，**不读配置、不碰任何全局状态**。
 *
 * **驱动一律动态 import**：这是「一个产物两种库」的前提。`@mikro-orm/sqlite` 一加载就会
 * 拉起 better-sqlite3（原生模块），`@mikro-orm/postgresql` 会拉起 pg —— 写成静态 import，
 * 连 PostgreSQL 的进程也得先把 SQLite 的原生模块 dlopen 一遍，反之亦然。进程只加载用得上的那一个。
 * 这两句 import 从本包解析，所以**本包要自己声明两个驱动**。
 *
 * 不连库：`MikroORM.init()` 只做实体发现，第一条查询才建连接。
 */

export type DbProvider = 'sqlite' | 'postgresql'

/** 从连接串协议反推 provider；认不出来返回 undefined，怎么处理由调用方定 */
export function providerFromUrl(url: string | undefined): DbProvider | undefined {
  if (!url) return undefined
  if (url.startsWith('file:')) return 'sqlite'
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgresql'
  return undefined
}

export interface OpenOrmOptions {
  provider: DbProvider
  /** PostgreSQL 连接串，或 SQLite 的 `file:<路径>` / 裸路径 */
  url: string
  entities: NonNullable<Options['entities']>
}

export async function openOrm(options: OpenOrmOptions): Promise<MikroORM> {
  const base = { entities: options.entities }

  if (options.provider === 'postgresql') {
    const { PostgreSqlDriver } = await import('@mikro-orm/postgresql')
    // 沿用 Prisma 时代的连接串写法 `...?schema=public`：pg 不认这个参数，摘出来交给 MikroORM 的 schema 选项
    const url = new URL(options.url)
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

  const dbName = options.url.startsWith('file:') ? options.url.slice('file:'.length) : options.url
  // better-sqlite3 不会自动建目录
  if (options.url.startsWith('file:')) mkdirSync(path.dirname(dbName), { recursive: true })
  const { SqliteDriver } = await import('@mikro-orm/sqlite')
  const orm = await MikroORM.init({ ...base, driver: SqliteDriver, dbName })
  return orm as unknown as MikroORM
}
