import { raw } from '@mikro-orm/core'

/**
 * 关键字模糊匹配（大小写不敏感）—— 两种库里行为要一致。
 *
 * MikroORM 自带的两个操作符都靠不住：
 * - `$like`：SQLite 的 LIKE 对 ASCII 天生大小写不敏感，PostgreSQL 的不是 —— 同一句「搜 abc」
 *   在 SQLite 里能搜到 "ABC"，在 PG 里搜不到；
 * - `$ilike`：PostgreSQL 专属，SQLite 上直接是语法错误。
 *
 * 所以统一写成 `lower(列) like lower(?)`：两边都是同一个 SQL 函数作用在两侧，
 * 比较的规则由同一个库决定，不会出现「列按库的规则小写、关键字按 JS 的规则小写」那种错位。
 * 关键字里的 `%` `_` `\` 转义掉，`escape '\'` 两种库都认 —— 搜「100%」就是字面的 100%。
 *
 * 用法：铺进 where 里，`{ deletedAt: null, ...containsIgnoreCase('name', keyword) }`。
 * 参数是**列名**（`UnderscoreNamingStrategy` 之后的名字），不是属性名；两者不同时要写列名。
 * 别名由 MikroORM 回填，放进关系的嵌套条件里（`{ project: { ...containsIgnoreCase('name', k) } }`）
 * 也指向正确的那张表。
 */
export function containsIgnoreCase(column: string, keyword: string) {
  const pattern = `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
  return {
    [raw((alias: string) => `lower(${alias}.${column}) like lower(?) escape '\\'`, [pattern])]: [],
  }
}
