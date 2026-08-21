import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_DATABASE_URL, TEST_DATA_DIR, TEST_DB_PROVIDER } from './paths.ts'

/**
 * 整轮测试跑一次：把测试库的结构对齐到 schema。
 *
 * 用真正的 `prisma db push`（而不是手写 CREATE TABLE）建表，是为了让测试库和生产库
 * 走**同一条**建表路径 —— schema 写错了测试就会红。项目不用迁移文件，
 * 结构同步就是 db push 这一条命令，两种 provider 都一样。
 *
 * - SQLite：先把 `data/test/` 整个删掉，等于每轮一个全新库；
 * - PostgreSQL：删不掉文件，靠 `--accept-data-loss` 让 db push 把结构对齐
 *   （表里的数据由每个用例自己的 `resetDb()` 清）。这个 flag 意味着它**可能删列删表**，
 *   所以 `TEST_DATABASE_URL` 必须指向专用测试库，别指生产。
 */
export default function setup() {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const prismaBin = path.join(repoRoot, 'node_modules/.bin/prisma')

  if (TEST_DB_PROVIDER === 'sqlite') {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  }

  // prisma.config.ts 也走 loadEnvFile，已存在的 DATABASE_URL / DB_PROVIDER 不会被 .env 覆盖
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    DB_PROVIDER: TEST_DB_PROVIDER,
  }

  const run = (args: string[]) => {
    try {
      execFileSync(prismaBin, args, { cwd: repoRoot, stdio: 'pipe', env })
    } catch (err) {
      const detail = err as { stdout?: Buffer; stderr?: Buffer }
      console.error(detail.stdout?.toString(), detail.stderr?.toString())
      throw new Error(`[test] prisma ${args.join(' ')} 失败（${TEST_DB_PROVIDER}）`, { cause: err })
    }
  }

  // 生成的 client 跟 provider 绑定（连查询编译器都是 sqlite / postgres 两套 wasm）：
  // 上一轮如果在另一种库上跑过，这里躺着的就是另一种 client。只在对不上时重新生成，
  // 免得每轮测试都白等一次 generate。
  const providerBefore = generatedProvider(repoRoot)
  if (providerBefore !== TEST_DB_PROVIDER) run(['generate'])

  // Prisma 7 的 db push 不再自动 generate（也没有 --skip-generate 这个选项了），
  // 所以 generate 完全由上面那一步管：只在 provider 对不上时才跑。
  //
  // `--accept-data-loss` **只在 PostgreSQL 上加**：那边删不掉库文件，库里可能留着
  // 上一轮（或别的 schema 版本）的表，不允许丢数据就推不上去。SQLite 不需要 ——
  // 上面已经把整个 data/test 删了，每轮都是全新库，压根没有数据可丢。
  const args = ['db', 'push']
  if (TEST_DB_PROVIDER !== 'sqlite') args.push('--accept-data-loss')
  run(args)

  // 上面那次 generate 是**破坏性**的：server/generated/prisma 只有一份，改成测试用的
  // provider 之后，.env 配的是另一种库的开发者就没法跑了 —— `pnpm dev` 会按 .env 挑
  // adapter，撞上另一种 provider 的 client，直接 PrismaClientInitializationError
  // （"The Driver Adapter `@prisma/adapter-pg` … is not compatible with the provider
  // `sqlite`"）。而且 tsx watch 不会自愈：改任何一个文件重启一次就再报一次，
  // 直到手动 `pnpm db:generate`。所以整轮跑完把 client 还原回原来的 provider。
  if (providerBefore && providerBefore !== TEST_DB_PROVIDER) {
    return () => {
      // 不带 DATABASE_URL / DB_PROVIDER，让 prisma.config.ts 自己按 .env 解析回开发配置
      const devEnv = { ...process.env }
      delete devEnv.DATABASE_URL
      delete devEnv.DB_PROVIDER
      try {
        execFileSync(prismaBin, ['generate'], { cwd: repoRoot, stdio: 'pipe', env: devEnv })
      } catch (err) {
        // 还原失败不该让整轮测试变红（测试本身已经跑完了），提示一句让人手动补上
        console.error(
          `[test] 把 Prisma client 还原成 ${providerBefore} 失败，跑一次 \`pnpm db:generate\``,
          err,
        )
      }
    }
  }
}

/** 现在生成出来的 client 是哪种库的；没生成过就返回 null */
function generatedProvider(repoRoot: string): string | null {
  try {
    const source = readFileSync(
      path.join(repoRoot, 'server/generated/prisma/internal/class.ts'),
      'utf8',
    )
    return /"activeProvider":\s*"([^"]+)"/.exec(source)?.[1] ?? null
  } catch {
    return null
  }
}
