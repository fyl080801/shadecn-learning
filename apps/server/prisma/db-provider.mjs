import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 数据库 provider 的解析规则 —— CLI 侧（prisma.config.ts、apps/server/scripts/build-server.mjs）的唯一实现。
 *
 * 服务端 apps/server/config.ts 里有一份等价的 TypeScript 实现：apps/server 是独立的 TS 项目
 * （没开 allowJs，也不引仓库根的文件），没法直接 import 这里。两边必须保持一致，
 * 否则会出现「CLI 迁移的是这个库、服务端连的是那个库」。改一边就改另一边。
 */

/** 支持的两种库。名字直接就是 prisma datasource 的 provider 值 */
export const DB_PROVIDERS = /** @type {const} */ (['sqlite', 'postgresql'])

/**
 * 后端包目录（apps/server）—— prisma.config.ts 和 schema 目录都在这下面，
 * prisma CLI 也是在这里跑的（cwd）。
 */
export const serverDir = path.resolve(import.meta.dirname, '..')

/**
 * 仓库根目录 —— .env 在这儿，DATA_DIR / DATABASE_URL 里的相对路径也都按它解析，不是 cwd。
 *
 * 和 serverDir 是两个基准，别混：schema 跟着后端包走，运行时数据跟着仓库根走
 * （和 apps/server/runtime.ts 的 appRoot 是同一个目录）。
 */
export const rootDir = path.resolve(serverDir, '..', '..')

/**
 * 每个 provider 一个 schema **目录**，路径相对 serverDir（也就是 prisma.config.ts 所在目录）。
 *
 * 目录而不是文件：Prisma 的多文件 schema 会把目录下所有 `.prisma` 合并成一份，
 * 于是 `apps/server/prisma/<provider>/models` 那个指向 `apps/server/prisma/models/` 的符号链接
 * 就让两个 provider 共用了同一批物理模型文件 —— 两边只有 schema.prisma 里
 * datasource 的一行 provider 不同，没有任何生成物、也就没有漂移可言。
 */
export function schemaDirOf(provider) {
  return `prisma/${provider}`
}

/**
 * 没有 `migrationsPathOf` —— **这个项目不用迁移文件**。
 *
 * 结构同步走 `prisma db push`（schema 直接推到库），所以既没有 `apps/server/prisma/migrations/`，
 * 也没有 `_prisma_migrations` 表要维护。原因见 docs/05-data-persistence.md：
 * 两种 provider 的 DDL 方言不同（`BLOB`/`BYTEA`、SQLite 不能改列…），
 * 迁移文件必然要写两份、条条对应，而这个项目没有需要照顾的存量数据。
 */

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
