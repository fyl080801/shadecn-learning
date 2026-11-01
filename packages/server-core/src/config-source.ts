import './env.ts'
import { readConfigFiles, resolveConfig, setting, type ConfigSchema, type ConfigSource } from '@shadecn/server-kit/config'
import { moduleConfigSchema, type AnyServerModule } from '@shadecn/server-kit/kernel'
import { appRoot } from './runtime.ts'

/**
 * 配置的来源（docs/28 §3.3）：应用根目录的 `server.config.{yaml,yml,json}` + `server.config.<NODE_ENV>.*`，再叠环境变量。
 *
 * - 底座的段（下面的 {@link coreConfigSchema}）在这里声明；每个模块的段由模块自己声明（模块定义的 `config.schema`），
 *   内核按入口交进来的模块清单挂到 `modules.<名字>` 下，每段自动带 `enabled`（`<NAME>_ENABLED`）；
 * - `SERVER_CONFIG` 显式指定文件（逗号分隔、按顺序叠，相对路径按应用根目录算；容器里指到挂进来的 ConfigMap），给了就不再自动找；
 *   **空串 = 不用配置文件**（测试这么配，开发者自己的文件不能漏进测试）；
 * - 环境变量（含 `.env`，`env.ts` 已经读进 `process.env`）优先于文件。
 *
 * 底座的 `config.ts` 经 {@link cfg} 取每一项、模块的 `config.parse` 经 {@link resolveFullConfig} 取（取到的都是和环境变量同形的字符串），
 * 默认值与解析各在一处 —— 从文件来、从环境变量来走同一条路。
 * `db:push` 经 `config.ts` 拿数据库连接，所以也认配置文件。
 */
export const coreConfigSchema = {
  server: {
    port: setting('PORT', 'number'),
    host: setting('HOST', 'string'),
    /** 这个进程扮演哪些角色（docs/28 §3.2）；不写 = 全部 */
    roles: setting('SERVER_ROLES', 'list', 'web / collab / agent'),
    instanceId: setting('INSTANCE_ID', 'string'),
    dataDir: setting('DATA_DIR', 'string'),
    staticDir: setting('STATIC_DIR', 'string'),
    origin: setting('APP_ORIGIN', 'string', '应用对外地址'),
    origins: setting('APP_ORIGINS', 'list', '允许的对外域名白名单'),
  },
  database: {
    provider: setting('DB_PROVIDER', 'string', 'sqlite / postgresql'),
    url: setting('DATABASE_URL', 'string'),
  },
  cluster: {
    mode: setting('CLUSTER_MODE', 'string', 'single / redis'),
    redisUrl: setting('REDIS_URL', 'string'),
    redisKeyPrefix: setting('REDIS_KEY_PREFIX', 'string'),
  },
  log: {
    level: setting('LOG_LEVEL', 'string'),
    format: setting('LOG_FORMAT', 'string', 'pretty / json'),
    dir: setting('LOG_DIR', 'string'),
    http: setting('LOG_HTTP', 'string', 'api / all / off'),
    slowMs: setting('LOG_SLOW_MS', 'number'),
    slowQueryMs: setting('LOG_SLOW_QUERY_MS', 'number'),
  },
} satisfies ConfigSchema

/** 叠哪一层环境文件：`NODE_ENV`，没设按 development（和 `config.ts` 的 `isDev` 同口径） */
const mode = process.env.NODE_ENV?.trim() || 'development'

const files = readConfigFiles({ dir: appRoot, mode, explicit: process.env.SERVER_CONFIG })

/**
 * 底座的段：import 时就解析（底座各处的配置常量在 import 时求值）。`modules` 段先原样放过 ——
 * 它长什么样要等模块清单交进来才知道，由 {@link resolveFullConfig} 再完整校验一遍。
 */
export const configSource = resolveConfig(coreConfigSchema, files, process.env, { deferred: ['modules'] })

/** 按环境变量名取底座的一项：环境变量优先，其次配置文件；都没有 = undefined（由调用方给默认值） */
export function cfg(name: string): string | undefined {
  return configSource.get(name)
}

/** 完整的 schema：底座的段 + `modules`（模块清单里每个模块一节，各自带 `enabled`） */
export function serverConfigSchema(modules: readonly AnyServerModule[]): ConfigSchema {
  return { ...coreConfigSchema, modules: moduleConfigSchema(modules) }
}

/**
 * 交进模块清单之后的完整解析：整份文件按完整的 schema 再校验一次（拼错的 `modules.agent.modle` 在这里报），
 * 环境变量名在底座和全部模块之间唯一。模块的 `config.parse` 从它取值。
 */
export function resolveFullConfig(modules: readonly AnyServerModule[]): ConfigSource {
  return resolveConfig(serverConfigSchema(modules), files, process.env)
}
