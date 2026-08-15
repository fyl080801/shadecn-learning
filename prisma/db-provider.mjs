import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 数据库 provider 的解析规则 —— CLI 侧（prisma.config.ts、scripts/prisma-schema.mjs）的唯一实现。
 *
 * 服务端 server/config.ts 里有一份等价的 TypeScript 实现：server/ 是独立的 TS 项目
 * （没开 allowJs，也不引仓库根的文件），没法直接 import 这里。两边必须保持一致，
 * 否则会出现「CLI 迁移的是这个库、服务端连的是那个库」。改一边就改另一边。
 */

/** 支持的两种库。名字直接就是 prisma datasource 的 provider 值 */
export const DB_PROVIDERS = /** @type {const} */ (['sqlite', 'postgresql'])

/** 仓库根目录 —— DATA_DIR / DATABASE_URL 里的相对路径都按它解析，不是 cwd */
export const rootDir = path.resolve(import.meta.dirname, '..')

/** 每个 provider 一份完整 schema（由 scripts/prisma-schema.mjs 生成），路径相对仓库根 */
export function schemaPathOf(provider) {
  return `prisma/schema.${provider}.prisma`
}

/** 迁移按 provider 分目录：两种库的 DDL 方言不同，历史也各走各的 */
export function migrationsPathOf(provider) {
  return `prisma/migrations/${provider}`
}

/**
 * 判断用哪种库：
 *   1. 显式的 DB_PROVIDER 最优先；
 *   2. 否则看 DATABASE_URL 的协议（`file:` → sqlite，`postgres(ql)://` → postgresql）；
 *   3. 什么都没设 → sqlite（零外部依赖的默认形态）。
 */
export function resolveProvider(env = process.env) {
  const explicit = env.DB_PROVIDER?.trim()
  if (explicit) {
    if (!DB_PROVIDERS.includes(explicit)) {
      throw new Error(`DB_PROVIDER 只能是 ${DB_PROVIDERS.join(' / ')}，收到的是 "${explicit}"`)
    }
    return explicit
  }
  return providerFromUrl(env.DATABASE_URL?.trim()) ?? 'sqlite'
}

/** 从连接串协议反推 provider；认不出来返回 undefined */
export function providerFromUrl(url) {
  if (!url) return undefined
  if (url.startsWith('file:')) return 'sqlite'
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgresql'
  return undefined
}

/**
 * 解析出最终连接串。sqlite 会把相对路径按仓库根补全，postgresql 原样透传。
 * provider 和连接串协议对不上直接抛错 —— 那种情况下继续跑只会连错库。
 */
export function resolveDatabaseUrl(env = process.env, provider = resolveProvider(env)) {
  const configured = env.DATABASE_URL?.trim()
  const scheme = providerFromUrl(configured)
  if (configured && scheme && scheme !== provider) {
    throw new Error(`DB_PROVIDER=${provider} 与 DATABASE_URL 的协议（${scheme}）不一致`)
  }

  if (provider === 'postgresql') {
    if (!configured) throw new Error('DB_PROVIDER=postgresql 时必须提供 DATABASE_URL')
    return configured
  }

  const dataDir = fromRoot(env.DATA_DIR ?? 'data')
  const url = configured ?? `file:${path.join(dataDir, 'app.db')}`
  return url.startsWith('file:') ? `file:${fromRoot(url.slice('file:'.length))}` : url
}

/** better-sqlite3 / prisma 都不会自动建目录，打开库文件前先把父目录补上 */
export function ensureDatabaseDir(url) {
  if (!url.startsWith('file:')) return
  mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true })
}

function fromRoot(target) {
  return path.isAbsolute(target) ? target : path.join(rootDir, target)
}
