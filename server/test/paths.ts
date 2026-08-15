import path from 'node:path'

/**
 * 测试专用的 SQLite 库位置。
 *
 * 刻意放在 data/ 下面（已 gitignore），并且和开发库 data/app.db 分开，
 * 跑测试永远不会碰到你本地正在用的数据。
 * vitest.config.ts 和 global-setup.ts 都从这里取路径，保证 CLI 迁移
 * 和测试进程打开的是同一个文件。
 */
export const TEST_DATA_DIR = path.resolve(import.meta.dirname, '../../data/test')

export const TEST_DB_FILE = path.join(TEST_DATA_DIR, 'app.db')

export const TEST_DATABASE_URL = `file:${TEST_DB_FILE}`
