import { existsSync } from 'node:fs'
import path from 'node:path'

// 本文件在 apps/server/test/ 下，往上三层才是仓库根（.env、data/ 都在那儿）
const repoRoot = path.resolve(import.meta.dirname, '../../..')

/**
 * 测试库的位置。
 *
 * 默认是 SQLite 文件，刻意放在 data/ 下面（已 gitignore），并且和开发库 data/app.db
 * 分开，跑测试永远不会碰到你本地正在用的数据。
 *
 * 想在 PostgreSQL 上跑同一套后端测试，设 `TEST_DATABASE_URL` 指向一个**专用测试库**即可
 * （global-setup 会对它 `db/sync-cli.ts --reset`：先删光实体对应的表、再连同实体之外的表
 * 一起对齐 —— 千万别指向开发库或生产库）：
 *
 *   TEST_DATABASE_URL=postgresql://app:app@127.0.0.1:5432/app_test pnpm test:server
 *
 * 写在 .env 里也行（见下面的 loadTestEnv）。想临时切回 SQLite，命令行上给个空值：
 * `TEST_DATABASE_URL= pnpm test:server`（loadEnvFile 不覆盖已存在的变量，空串也算存在）。
 *
 * apps/server/vitest.config.ts 和 global-setup.ts 都从这里取，保证 CLI 和测试进程打开的是同一个库。
 */

/**
 * 把 .env 里的 `TEST_*` 变量读进来 —— 只有这一类，别的一个都不放行。
 *
 * 为什么要自己读：vitest.config.ts 在**顶层** import 本模块，而 Vitest 要等 config
 * 解析完才会去碰 .env，那时 TEST_DATABASE_URL 早就被算成默认的 sqlite 了。
 * 于是写在 .env 里的那行看着生效、实际整轮测试还是跑 SQLite（表都建在别处）。
 *
 * 为什么只放 `TEST_` 前缀：测试跟开发者本地的 .env（真实 Keycloak、真实密钥、真实开发库）
 * 彻底无关是这套测试的前提 —— apps/server/env.ts 被换成空实现、环境全由 vitest.config.ts
 * 的 test.env 提供，都是为了这个。`TEST_` 开头的变量本来就是**只给测试用的**，
 * 不属于那份要隔离的开发配置，所以是这条规则唯一的例外。
 *
 * loadEnvFile 不覆盖已存在的变量，所以命令行上显式传的 TEST_DATABASE_URL 仍然优先。
 */
function loadTestEnv() {
  const dotEnv = path.join(repoRoot, '.env')
  if (!existsSync(dotEnv)) return

  const before = new Set(Object.keys(process.env))
  process.loadEnvFile(dotEnv)
  for (const key of Object.keys(process.env)) {
    if (!before.has(key) && !key.startsWith('TEST_')) delete process.env[key]
  }
}

loadTestEnv()

export const TEST_DATA_DIR = path.join(repoRoot, 'data/test')

export const TEST_DB_FILE = path.join(TEST_DATA_DIR, 'app.db')

const configured = process.env.TEST_DATABASE_URL?.trim()

export const TEST_DATABASE_URL = configured || `file:${TEST_DB_FILE}`

export const TEST_DB_PROVIDER: 'sqlite' | 'postgresql' = TEST_DATABASE_URL.startsWith('file:')
  ? 'sqlite'
  : 'postgresql'
