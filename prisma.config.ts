import { defineConfig } from 'prisma/config'
import {
  ensureDatabaseDir,
  migrationsPathOf,
  resolveDatabaseUrl,
  resolveProvider,
  schemaPathOf,
} from './prisma/db-provider.mjs'

// 用 node 自带的 .env 读取，省掉 dotenv 依赖（node >= 20.12 就有 loadEnvFile）
try {
  process.loadEnvFile()
} catch {
  // 没有 .env 就走进程里已有的环境变量
}

// provider 和连接串的解析规则见 prisma/db-provider.mjs，
// server/config.ts 里有一份等价实现 —— CLI（迁移）和服务端进程必须落到同一个库上。
const provider = resolveProvider()
const url = resolveDatabaseUrl(process.env, provider)
ensureDatabaseDir(url)

export default defineConfig({
  // 两份 schema 由 `pnpm db:schema` 从 prisma/models.prisma 生成
  schema: schemaPathOf(provider),
  migrations: {
    // 迁移历史按 provider 分开：DDL 方言不同，不能混用同一套文件
    path: migrationsPathOf(provider),
  },
  datasource: { url },
})
