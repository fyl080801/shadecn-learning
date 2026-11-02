import { randomUUID } from 'node:crypto'
import { p, raw, type EntityManager } from '@mikro-orm/core'

/**
 * 数据库的平台能力（docs/28 §3.1.2）：拿 EntityManager、写实体用的列、跨库一致的查询片段。
 *
 * **ORM 实例归底座**：宿主按「底座的实体 + 模块清单里每个模块声明的 `entities`」建一个 MikroORM（`packages/server-core/src/db.ts`），
 * 建好后调 {@link configureDatabase} 交进来。模块里的 store 只调 {@link db}，不认识 ORM 怎么建、连的是哪种库。
 *
 * ## 一份定义，两种库
 *
 * 实体定义里**不出现任何数据库专属的东西**，运行时由 `DATABASE_PROVIDER` 选驱动，同一个构建产物既能连 SQLite 也能连 PostgreSQL。
 * 为此只用五种类型：
 *
 * | 用途 | 构建器 | SQLite | PostgreSQL |
 * |---|---|---|---|
 * | 字符串（含主键、外键） | `p.text()` | `text` | `text` |
 * | 整数 | `p.integer()` | `integer` | `int` |
 * | 布尔 | `p.boolean()` | `integer` | `boolean` |
 * | 时刻 | `p.datetime()` | `datetime` | `timestamptz` |
 * | 二进制 | `p.blob()` | `blob` | `bytea` |
 *
 * - **字符串一律 `p.text()`，不用 `p.string()`**：后者在 PG 上是 `varchar(255)`，SQLite 不限长 ——
 *   会话的 access_token、头像地址这类值在 SQLite 上写得进去、到 PG 上就截断报错，而且只有换了库才发现。
 * - **不用 json / enum / array / 任何原生列类型**。JSON 照旧存成字符串（`roles`、`tags`、`graph`），枚举照旧是字符串加应用层校验。
 * - **时刻的默认值在应用里给，不给数据库默认值**（`onCreate` / `onUpdate`）。`current_timestamp` 在两种库里的存储格式不一样。
 *
 * ## `onCreate` / `onUpdate` 只在工作单元（`em.create` + `flush`）里生效
 *
 * `em.nativeUpdate` / `em.insert` / `em.upsert` 这些「直接发 SQL」的写法**不会**触发它们。所以：
 * - 用 `nativeUpdate` 改了内容的地方要显式写 `updatedAt: new Date()`；
 * - 用 `insert` / `upsert` 建行时要显式给 `id`（{@link newId}）和 `createdAt`。
 */

let fork: (() => EntityManager) | null = null

/** 宿主建好 ORM 之后调一次（重复调用 = 换一个，测试里重建 ORM 时用） */
export function configureDatabase(forkEntityManager: () => EntityManager): void {
  fork = forkEntityManager
}

/**
 * 拿一个干净的 EntityManager —— **每次数据库操作（或一组要放进同一事务的操作）都 fork 一个**。
 *
 * EntityManager 带着身份映射，同一个实例被并发的请求共用，一个请求读到的实体会被另一个请求的 flush 带出去。
 * 全局实例因此默认禁止直接使用（`allowGlobalContext: false`），这里也不靠 RequestContext 中间件 ——
 * store 层每个函数自己 fork 自己的，脱离 HTTP 请求（协同落库、定时清理）也一样能用。
 */
export function db(): EntityManager {
  if (!fork) throw new Error('[db] 数据库还没交给平台（宿主要先 configureDatabase）')
  return fork()
}

/** 主键的生成规则：服务端生成的 UUID 文本。直接发 SQL 建行时用它补 id */
export const newId = () => randomUUID()

/** 文本主键，由 {@link newId} 在建行时生成 */
export const idColumn = () =>
  p
    .text()
    .primary()
    .onCreate(() => newId())

/** 建行时刻 */
export const createdAtColumn = () => p.datetime().onCreate(() => new Date())

/** 最后修改时刻。**直接发 SQL 的更新不会自动改它**，见文件头 */
export const updatedAtColumn = () =>
  p
    .datetime()
    .onCreate(() => new Date())
    .onUpdate(() => new Date())

/**
 * 关键字模糊匹配（大小写不敏感）—— 两种库里行为要一致。
 *
 * MikroORM 自带的两个操作符都靠不住：`$like` 在 SQLite 上对 ASCII 天生大小写不敏感、PostgreSQL 上不是；
 * `$ilike` 是 PostgreSQL 专属，SQLite 上直接是语法错误。所以统一写成 `lower(列) like lower(?)`。
 * 关键字里的 `%` `_` `\` 转义掉，`escape '\'` 两种库都认 —— 搜「100%」就是字面的 100%。
 *
 * 用法：铺进 where 里，`{ deletedAt: null, ...containsIgnoreCase('name', keyword) }`。
 * 参数是**列名**（`UnderscoreNamingStrategy` 之后的名字），不是属性名；两者不同时要写列名。
 */
export function containsIgnoreCase(column: string, keyword: string) {
  const pattern = `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
  return {
    [raw((alias: string) => `lower(${alias}.${column}) like lower(?) escape '\\'`, [pattern])]: [],
  }
}
