import path from 'node:path'

/**
 * 测试库的位置。
 *
 * 默认是 SQLite 文件，刻意放在 data/ 下面（已 gitignore），并且和开发库 data/app.db
 * 分开，跑测试永远不会碰到你本地正在用的数据。
 *
 * 想在 PostgreSQL 上跑同一套后端测试，设 `TEST_DATABASE_URL` 指向一个**可以被清空的**
 * 库即可（global-setup 会 `migrate reset`，库里原有的表会被删光）：
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_test pnpm test:server
 *
 * vitest.config.ts 和 global-setup.ts 都从这里取，保证 CLI 迁移和测试进程打开的是同一个库。
 */
export const TEST_DATA_DIR = path.resolve(import.meta.dirname, '../../data/test')

export const TEST_DB_FILE = path.join(TEST_DATA_DIR, 'app.db')

const configured = process.env.TEST_DATABASE_URL?.trim()

export const TEST_DATABASE_URL = configured || `file:${TEST_DB_FILE}`

export const TEST_DB_PROVIDER: 'sqlite' | 'postgresql' = TEST_DATABASE_URL.startsWith('file:')
  ? 'sqlite'
  : 'postgresql'
