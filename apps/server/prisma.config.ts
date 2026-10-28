import { defineConfig } from 'prisma/config'
import {
  ensureDatabaseDir,
  resolveDatabaseUrl,
  resolveProvider,
  schemaDirOf,
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

// 没有 migrations 配置：结构同步走 `prisma db push`，这个项目不留迁移历史。
// 为什么这么选，见 docs/05-data-persistence.md
export default defineConfig({
  // 指向**目录**：prisma/<provider>/ 下是 schema.prisma（generator + datasource）
  // 加一个指向 prisma/models/ 的符号链接，Prisma 的多文件 schema 会把它们合起来。
  // 模型只有一份物理文件，两个 provider 共用
  schema: schemaDirOf(provider),
  datasource: { url },
})
