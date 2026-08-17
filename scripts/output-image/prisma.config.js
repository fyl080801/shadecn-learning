// 产物自带的 prisma CLI 配置：容器启动时 `npx prisma db push` 用它。
// 路径解析必须和 server/runtime.ts + server/config.ts 保持一致：
// schema 跟着产物目录走，库文件跟着进程 cwd 走（产物运行时的「应用根目录」就是 cwd）。
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

try {
  process.loadEnvFile(path.join(process.cwd(), '.env'))
} catch {
  // 没有 .env 就走进程里已有的环境变量（容器里就是这种情况）
}

const fromRoot = (target) => (path.isAbsolute(target) ? target : path.join(process.cwd(), target))

const dataDir = fromRoot(process.env.DATA_DIR ?? 'data')
const configured = process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`
const url = configured.startsWith('file:')
  ? `file:${fromRoot(configured.slice('file:'.length))}`
  : configured

// better-sqlite3 / prisma 都不会自动建目录
if (url.startsWith('file:')) {
  mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true })
}

// 没有 migrations 配置：结构同步走 db push，产物里也没有 prisma/migrations 目录。
//
// **schema 必须指向目录，不是 prisma/schema.prisma 那个文件**：产物里是多文件 schema
// （schema.prisma 只有 generator + datasource，模型在 prisma/models/*.prisma）。
// 指到单个文件的话 Prisma 只读那一个文件、一个 model 都看不到，
// 于是 db push 会认为「schema 是空的、库也是空的，已经一致」，
// 建出一个 0 字节的空库还报 “already in sync” —— 一张表都没有，服务起来才发现。
export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma'),
  datasource: { url },
})
