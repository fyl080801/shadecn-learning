import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

// 用 node 自带的 .env 读取，省掉 dotenv 依赖（node >= 20.12 就有 loadEnvFile）
try {
  process.loadEnvFile()
} catch {
  // 没有 .env 就走进程里已有的环境变量
}

// 这段要和 server/config.ts 里的解析保持一致：
// DATA_DIR / DATABASE_URL 的相对路径都按仓库根目录算，
// 这样 CLI（迁移）和服务端进程打开的是同一个库文件。
const rootDir = import.meta.dirname
const fromRoot = (target: string) => (path.isAbsolute(target) ? target : path.join(rootDir, target))

const dataDir = fromRoot(process.env['DATA_DIR'] ?? 'data')
const configured = process.env['DATABASE_URL'] ?? `file:${path.join(dataDir, 'app.db')}`
const url = configured.startsWith('file:')
  ? `file:${fromRoot(configured.slice('file:'.length))}`
  : configured

// better-sqlite3 / prisma 都不会自动建目录
if (url.startsWith('file:')) {
  mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true })
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: { url },
})
