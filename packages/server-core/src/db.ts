import type { EntityManager, MikroORM, Options } from '@mikro-orm/core'
import { configureDatabase } from '@shadecn/server-kit/db'
import { createOrm } from './db/orm.ts'

/**
 * 服务端进程的 MikroORM 单例。
 *
 * **实体由入口交进来**（底座的 + 模块清单里每个模块声明的 `entities`），所以单例不能在 import 时建：
 * `prepare(modules)` 调 {@link initDatabase}，之后 {@link orm} / {@link db} 才可用，平台的 `db()`（`@shadecn/server-kit/db`）也是这时接上的。
 * `MikroORM.init()` 本身不连库（第一条查询才连），所以数据库不通也不会卡住启动。
 *
 * dev 下 tsx watch 会反复重新加载模块，挂到 globalThis 上避免连接越开越多。
 */
const globalForOrm = globalThis as unknown as { __mikroOrm?: MikroORM }

let current: MikroORM | undefined

/**
 * 按这份实体集建（或复用）ORM。缓存只在「实体是同一份」时才复用：模块图被整个重新执行时（测试里的 `vi.resetModules()`），
 * `defineEntity` 会产出一批新的实体对象，旧 ORM 的元数据里没有它们 —— 拿新实体去查旧 ORM
 * 会报一句莫名其妙的 `Cannot set properties of undefined (setting '__schema')`。那种情况下另建一个。
 */
export async function initDatabase(entities: NonNullable<Options['entities']>): Promise<MikroORM> {
  const cached = globalForOrm.__mikroOrm
  const sameEntities =
    cached !== undefined &&
    (cached.config.get('entities') as readonly unknown[]).length === entities.length &&
    (cached.config.get('entities') as readonly unknown[]).every((entity, index) => entity === entities[index])
  current = sameEntities ? cached : await createOrm({ entities })
  globalForOrm.__mikroOrm = current
  // 交给平台：模块里的 store 经 `@shadecn/server-kit/db` 的 `db()` 拿 EntityManager，不认识这个单例
  configureDatabase(() => orm().em.fork())
  return current
}

/** 当前的 ORM；还没 `initDatabase` → 抛（入口要先 `prepare`） */
export function orm(): MikroORM {
  if (!current) throw new Error('[db] 数据库还没初始化（入口要先 prepare(modules)）')
  return current
}

/**
 * 拿一个干净的 EntityManager —— **每次数据库操作（或一组要放进同一事务的操作）都 fork 一个**。
 *
 * MikroORM 的 EntityManager 带着身份映射（identity map），同一个实例被并发的请求共用，
 * 一个请求读到的实体会被另一个请求的 flush 带出去。全局实例因此默认禁止直接使用
 * （`allowGlobalContext: false`），这里也不靠 RequestContext 中间件 —— store 层每个函数
 * 自己 fork 自己的，自给自足，脱离 HTTP 请求（协同落库、定时清理）也一样能用。
 */
export function db(): EntityManager {
  return orm().em.fork()
}

export async function disconnectDb() {
  if (!current) return
  await current.close()
  current = undefined
  delete globalForOrm.__mikroOrm
}
