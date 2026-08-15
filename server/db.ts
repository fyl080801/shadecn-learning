import { databaseUrl, dbProvider, ensureDatabaseDir } from './config.ts'
import { PrismaClient } from './generated/prisma/client.ts'

/**
 * Prisma 7 走 driver adapter：连哪种库由 DB_PROVIDER / DATABASE_URL 决定
 * （解析规则见 config.ts），这里只负责挑对应的 adapter。
 *
 * 两个 adapter 都是**动态** import：构建产物是绑定 provider 的（生成的 client 里编译
 * 进去的查询编译器就一套），scripts/build-server.mjs 会把用不上的那个 adapter 从运行时
 * 依赖里剔掉 —— 写成静态 import 的话，被剔掉的包会变成顶层依赖，生产一启动就找不到模块。
 *
 * 生成的 client 在 server/generated/prisma（gitignore 了，`pnpm db:generate` 生成）。
 * 两种 provider 共用同一份模型定义，生成出来的类型一致，所以业务代码不分叉。
 *
 * dev 下 tsx watch 会反复重新加载模块，挂到 globalThis 上避免连接越开越多。
 */
ensureDatabaseDir()

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

async function createAdapter() {
  if (dbProvider === 'postgresql') {
    const { PrismaPg } = await import('@prisma/adapter-pg')
    // Prisma 风格的连接串常带 ?schema=xxx，但 pg 不认这个参数 —— 摘出来单独传
    const url = new URL(databaseUrl)
    const schema = url.searchParams.get('schema') ?? undefined
    url.searchParams.delete('schema')
    return new PrismaPg({ connectionString: url.toString() }, schema ? { schema } : undefined)
  }

  const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3')
  return new PrismaBetterSqlite3({ url: databaseUrl })
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: await createAdapter() })

globalForPrisma.prisma = prisma

export async function disconnectDb() {
  await prisma.$disconnect()
}
