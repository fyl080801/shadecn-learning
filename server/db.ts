import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { databaseUrl, ensureDatabaseDir } from './config.ts'
import { PrismaClient } from './generated/prisma/client.ts'

/**
 * Prisma 7 走 driver adapter：SQLite 由 better-sqlite3 打开，
 * 生成的 client 在 server/generated/prisma（gitignore 了，`pnpm db:generate` 生成）。
 *
 * dev 下 tsx watch 会反复重新加载模块，挂到 globalThis 上避免连接越开越多。
 */
ensureDatabaseDir()

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databaseUrl }),
  })

globalForPrisma.prisma = prisma

export async function disconnectDb() {
  await prisma.$disconnect()
}
