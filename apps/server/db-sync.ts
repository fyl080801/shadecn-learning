import '@shadecn/server-core/env'
import { runSchemaSyncCli } from '@shadecn/server-core/db-sync'
import { modules } from './modules.ts'

/**
 * 表结构同步的入口（`pnpm db:push`，产物里是 `output/server/db-sync.js`）：底座的同步命令 + 这个产物的模块清单。
 * 参数与守卫见 `@shadecn/server-core/db-sync`。
 */
await runSchemaSyncCli(modules)
