import { dbProvider } from '../config.ts'

/**
 * 关键字模糊匹配 —— 两种库里行为要一致。
 *
 * SQLite 的 LIKE 对 ASCII 天生大小写不敏感，PostgreSQL 的不是：同一句「搜 abc」
 * 在 SQLite 里能搜到 "ABC"，在 PG 里搜不到。PG 下补一个 `mode: 'insensitive'`
 * （Prisma 会翻成 ILIKE）把两边拉齐。
 *
 * 这里的类型断言是必要的：`mode` 只存在于 PostgreSQL 版生成的 client 类型里，
 * sqlite 版的 StringFilter 根本没这个字段，直接写会让 `pnpm typecheck:server`
 * 在 sqlite 客户端下报错。运行时只在 PG 上带上这个字段，sqlite 永远看不到它。
 */
export function nameContains(keyword: string): { contains: string } {
  if (dbProvider !== 'postgresql') return { contains: keyword }
  return { contains: keyword, mode: 'insensitive' } as { contains: string }
}
