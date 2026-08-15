import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_DATABASE_URL, TEST_DATA_DIR } from './paths.ts'

/**
 * 整轮测试跑一次：删掉上次的测试库，重新建目录，用真正的 prisma 迁移建表。
 *
 * 用 `prisma migrate deploy` 而不是手写 CREATE TABLE，是为了让测试库和
 * 生产库的 schema 永远一致 —— 迁移写错了测试就会红。
 */
export default function setup() {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DATA_DIR, { recursive: true })

  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const prismaBin = path.join(repoRoot, 'node_modules/.bin/prisma')

  try {
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: repoRoot,
      stdio: 'pipe',
      // prisma.config.ts 也走 loadEnvFile，已存在的 DATABASE_URL 不会被 .env 覆盖
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    })
  } catch (err) {
    const detail = err as { stdout?: Buffer; stderr?: Buffer }
    console.error(detail.stdout?.toString(), detail.stderr?.toString())
    throw new Error('[test] prisma migrate deploy 失败，测试库没建起来', { cause: err })
  }
}
