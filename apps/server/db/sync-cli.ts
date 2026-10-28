import '../env.ts'
import { dbProvider } from '../config.ts'
import { createOrm } from './orm.ts'
import { SchemaDataLossError, resetSchema, syncSchema } from './schema-sync.ts'

/**
 * 表结构同步的命令行入口 —— `prisma db push` 的替代品。
 *
 * 源码态：`pnpm db:push` / `pnpm db:push:force`（apps/server 下 `tsx db/sync-cli.ts [--force]`）；
 * 产物态：esbuild 把它打成 `output/server/db-sync.js`，容器 CMD 是
 * `node server/db-sync.js && node server/index.js`。两边跑的是同一份代码、同一道守卫。
 *
 *   （无参数）   只放行加表 / 加列 / 加索引这类变更；会丢数据的拒绝并列出语句，退出码 1
 *   --force      连有损变更一起执行（并删掉库里实体之外的表）。相当于原来的 --accept-data-loss
 *   --reset      先删光实体对应的表再完整同步。只给专用测试库用（global-setup），别对着有数据的库跑
 *
 * 连哪个库和服务端进程完全一样（同一个 config.ts，同一份 .env），不会出现「同步的是这个库、
 * 服务端连的是那个库」。
 */

const args = new Set(process.argv.slice(2))
const reset = args.has('--reset')
const force = reset || args.has('--force')

const unknown = [...args].filter((arg) => !['--force', '--reset'].includes(arg))
if (unknown.length > 0) {
  console.error(`[db] 不认识的参数：${unknown.join(' ')}（只有 --force / --reset）`)
  process.exit(2)
}

let exitCode = 0
let orm: Awaited<ReturnType<typeof createOrm>> | undefined

try {
  orm = await createOrm()
  const result = reset ? await resetSchema(orm) : await syncSchema(orm, { force })

  if (!result.applied) {
    console.log(`[db] 表结构已与实体定义一致（${dbProvider}），无需变更`)
  } else {
    console.log(`[db] 已同步表结构（${dbProvider}），执行了 ${result.statements.length} 句：`)
    for (const statement of result.statements) console.log(`  ${statement}`)
    if (result.dataLoss.length > 0) {
      console.warn(`[db] 其中 ${result.dataLoss.length} 句是有损变更（--force 放行）`)
    }
  }

  if (!force && result.unmanagedTables.length > 0) {
    console.warn(
      `[db] 库里有 ${result.unmanagedTables.length} 张实体之外的表，没有动它们：` +
        `${result.unmanagedTables.join(', ')}（要清掉就 --force，会连同里面的数据一起删）`,
    )
  }
} catch (err) {
  exitCode = 1
  if (err instanceof SchemaDataLossError) {
    console.error(`[db] ${err.message}`)
    console.error(
      '[db] 确认要丢掉这些数据的话：源码态 `pnpm db:push:force`，产物里 `node server/db-sync.js --force`',
    )
  } else {
    console.error('[db] 表结构同步失败', err)
  }
} finally {
  await orm?.close().catch(() => undefined)
}

process.exit(exitCode)
