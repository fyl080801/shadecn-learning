import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_DATABASE_URL, TEST_DATA_DIR, TEST_DB_PROVIDER } from './paths.ts'

/**
 * 整轮测试跑一次：清掉上次的测试库，用真正的 prisma 迁移建表。
 *
 * 用 `prisma migrate` 而不是手写 CREATE TABLE，是为了让测试库和生产库的 schema
 * 永远一致 —— 迁移写错了测试就会红。
 *
 * - SQLite：删文件目录再 `migrate deploy`；
 * - PostgreSQL：`migrate reset --force`，它会 drop 掉库里的所有表再重放迁移
 *   （所以 TEST_DATABASE_URL 必须指向一个专用的测试库，别指生产）。
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
  if (generatedProvider(repoRoot) !== TEST_DB_PROVIDER) run(['generate'])

  run(TEST_DB_PROVIDER === 'sqlite' ? ['migrate', 'deploy'] : ['migrate', 'reset', '--force'])
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
