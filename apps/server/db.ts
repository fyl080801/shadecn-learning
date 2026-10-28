import type { EntityManager, MikroORM } from '@mikro-orm/core'
import { entities } from './db/entities/index.ts'
import { createOrm } from './db/orm.ts'

/**
 * 服务端进程的 MikroORM 单例。
 *
 * 模块顶层 await 建好：`index.ts` 的 import 链（app → routes → store → 这里）在 listen 之前
 * 就把它跑完了，任何 import 了它的模块拿到的都是一个可用的实例，不存在「还没 init」的窗口。
 * `MikroORM.init()` 本身不连库（第一条查询才连），所以数据库不通也不会卡住启动。
 *
 * dev 下 tsx watch 会反复重新加载模块，挂到 globalThis 上避免连接越开越多。
 */
const globalForOrm = globalThis as unknown as { __mikroOrm?: MikroORM }

/**
 * 缓存只在「实体是同一份」时才复用。模块图被整个重新执行时（测试里的 `vi.resetModules()`），
 * `defineEntity` 会产出一批新的实体对象，旧 ORM 的元数据里没有它们 —— 拿新实体去查旧 ORM
 * 会报一句莫名其妙的 `Cannot set properties of undefined (setting '__schema')`。那种情况下另建一个。
 */
const cached = globalForOrm.__mikroOrm
export const orm: MikroORM =
  cached && cached.config.get('entities') === entities ? cached : await createOrm()
globalForOrm.__mikroOrm = orm

/**
 * 拿一个干净的 EntityManager —— **每次数据库操作（或一组要放进同一事务的操作）都 fork 一个**。
 *
 * MikroORM 的 EntityManager 带着身份映射（identity map），同一个实例被并发的请求共用，
 * 一个请求读到的实体会被另一个请求的 flush 带出去。全局实例因此默认禁止直接使用
 * （`allowGlobalContext: false`），这里也不靠 RequestContext 中间件 —— store 层每个函数
 * 自己 fork 自己的，自给自足，脱离 HTTP 请求（协同落库、定时清理）也一样能用。
 */
export function db(): EntityManager {
  return orm.em.fork()
}

export async function disconnectDb() {
  await orm.close()
  delete globalForOrm.__mikroOrm
}
