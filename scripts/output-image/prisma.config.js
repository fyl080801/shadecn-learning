// 产物自带的 prisma CLI 配置：容器启动时 `npx prisma migrate deploy` 用它。
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

export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma/schema.prisma'),
  migrations: { path: path.join(import.meta.dirname, 'prisma/migrations') },
  datasource: { url },
})
