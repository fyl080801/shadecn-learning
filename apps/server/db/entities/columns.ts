import { randomUUID } from 'node:crypto'
import { p } from '@mikro-orm/core'

/**
 * 实体里反复出现的几种列，以及写实体时必须守住的规矩。
 *
 * ## 一份定义，两种库
 *
 * 实体定义里**不出现任何数据库专属的东西**，运行时由 `DB_PROVIDER` 选驱动（见 `../orm.ts`），
 * 同一个构建产物既能连 SQLite 也能连 PostgreSQL。为此只用五种类型：
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
 *   会话的 access_token、头像地址这类值在 SQLite 上写得进去、到 PG 上就截断报错，
 *   而且只有换了库才发现。
 * - **不用 json / enum / array / 任何原生列类型**。JSON 照旧存成字符串（`roles`、`tags`、`graph`），
 *   枚举照旧是字符串加应用层校验。两边都有的类型才能保证两边行为一样。
 * - **时刻的默认值在应用里给，不给数据库默认值**（`onCreate` / `onUpdate`）。
 *   `current_timestamp` 在两种库里的存储格式不一样，混进来就会出现两种格式的时刻并存。
 *
 * ## `onCreate` / `onUpdate` 只在工作单元（`em.create` + `flush`）里生效
 *
 * `em.nativeUpdate` / `em.insert` / `em.upsert` 这些「直接发 SQL」的写法**不会**触发它们 ——
 * Prisma 的 `@updatedAt` 在 `updateMany` 里会自动带上，这里不会。所以：
 * - 用 `nativeUpdate` 改了内容的地方要显式写 `updatedAt: new Date()`；
 * - 用 `insert` / `upsert` 建行时要显式给 `id`（{@link newId}）和 `createdAt`。
 */

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
