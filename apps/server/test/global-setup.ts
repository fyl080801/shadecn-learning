import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_DATABASE_URL, TEST_DATA_DIR, TEST_DB_PROVIDER } from './paths.ts'

/**
 * 整轮测试跑一次：把测试库的结构对齐到实体定义。
 *
 * 用真正的表结构同步入口（`db/sync-cli.ts`，也就是 `pnpm db:push` 和容器启动跑的那一个）
 * 建表，而不是手写 CREATE TABLE，是为了让测试库和生产库走**同一条**建表路径 ——
 * 实体写错了测试就会红。
 *
 * - SQLite：先把 `data/test/` 整个删掉，每轮一个全新库，再正常同步（守卫照常生效）；
 * - PostgreSQL：删不掉文件，用 `--reset` 先删光实体对应的表、再完整同步（连同库里实体之外的表
 *   一起删掉）。所以 `TEST_DATABASE_URL` **必须指向专用测试库**，别指开发库或生产库。
 *
 * 放在子进程里跑：同步入口会读仓库根的 .env（真实 Keycloak、真实开发库…），在子进程里读
 * 就只影响那一个进程，污染不到 Vitest 主进程、也就到不了各个测试 worker。连哪个库由这里显式
 * 传的 DATABASE_URL / DB_PROVIDER 决定 —— loadEnvFile 不覆盖已存在的变量。
 */
export default function setup() {
  const serverDir = path.resolve(import.meta.dirname, '..')
  const tsxBin = path.join(serverDir, 'node_modules/.bin/tsx')

  const args = ['db/sync-cli.ts']
  if (TEST_DB_PROVIDER === 'sqlite') {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DATA_DIR, { recursive: true })
  } else {
    args.push('--reset')
  }

  try {
    execFileSync(tsxBin, args, {
      cwd: serverDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        DB_PROVIDER: TEST_DB_PROVIDER,
        // 同步过程中的 SQL 日志不要混进测试输出
        LOG_LEVEL: 'warn',
      },
    })
  } catch (err) {
    const detail = err as { stdout?: Buffer; stderr?: Buffer }
    console.error(detail.stdout?.toString(), detail.stderr?.toString())
    throw new Error(`[test] 表结构同步失败（${TEST_DB_PROVIDER}）`, { cause: err })
  }
}
