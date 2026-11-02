import './env.ts'
import path from 'node:path'
import { readConfigFiles, resolveConfig, setting, type ConfigPath, type ConfigSchema, type ConfigSource } from '@shadecn/server-kit/config'
import { moduleConfigSchema, type AnyServerModule } from '@shadecn/server-kit/kernel'
import { appRoot } from './runtime.ts'

/**
 * 运行时数据目录：SQLite 库、配置文件、模型表都放这儿，整个目录已 gitignore。
 * DATA_DIR 可覆盖（相对路径按应用根目录算，绝对路径直接用），容器里就是靠它指到挂载卷上。
 *
 * **只认环境变量（含 `.env`），不进配置文件的 schema**：配置文件就在这个目录里，读它之前必须已经知道目录在哪。
 */
export const dataDir = path.resolve(appRoot, process.env.DATA_DIR?.trim() || 'data')

/**
 * 配置的来源（docs/28 §3.3）：数据目录里的 `server.config.{yaml,yml,json}` + `server.config.<NODE_ENV>.*`，再叠环境变量。
 *
 * - 底座的段（下面的 {@link coreConfigSchema}）在这里声明；每个模块的段由模块自己声明（模块定义的 `config.schema`），
 *   内核按入口交进来的模块清单挂到 `modules.<名字>` 下，每段自动带 `enabled`；
 * - `SERVER_CONFIG` 显式指定文件（逗号分隔、按顺序叠，相对路径按数据目录算；容器里指到挂进来的 ConfigMap），给了就不再自动找；
 *   **空串 = 不用配置文件**（测试这么配，开发者自己的文件不能漏进测试）；
 * - 环境变量（含 `.env`，`env.ts` 已经读进 `process.env`）优先于文件；变量名由 schema 的路径推导（`server.port` → `SERVER_PORT`，`envNameOf`），schema 里只写路径和类型。
 *
 * 底座的 `config.ts` 经 {@link cfg} 按路径取每一项、模块的 `config.parse` 经 {@link resolveFullConfig} 取（取到的都是和环境变量同形的字符串），
 * 默认值与解析各在一处 —— 从文件来、从环境变量来走同一条路。
 * `db:push` 经 `config.ts` 拿数据库连接，所以也认配置文件。
 */
export const coreConfigSchema = {
  server: {
    port: setting('number'),
    host: setting('string'),
    /** 这个进程扮演哪些角色（docs/28 §3.2）；不写 = 全部 */
    roles: setting('list', 'web / collab / agent'),
    instanceId: setting('string'),
    staticDir: setting('string'),
    origin: setting('string', '应用对外地址'),
    origins: setting('list', '允许的对外域名白名单'),
  },
  database: {
    provider: setting('string', 'sqlite / postgresql'),
    url: setting('string'),
  },
  cluster: {
    mode: setting('string', 'single / redis'),
    redisUrl: setting('string'),
    redisKeyPrefix: setting('string'),
  },
  log: {
    level: setting('string'),
    format: setting('string', 'pretty / json'),
    dir: setting('string'),
    http: setting('string', 'api / all / off'),
    slowMs: setting('number'),
    slowQueryMs: setting('number'),
  },
  /** 语言服务提供方（形状照 pi 的 models.json，校验在 `@shadecn/server-kit/llm`）；agent 和应用表都引用它 */
  llm: {
    providers: setting('json', '提供方 id → { name, baseUrl, api, apiKey, models }'),
  },
} satisfies ConfigSchema

/**
 * 引导变量：读配置之前就要知道（定位配置文件、选环境分层），只认环境变量，不在 schema 里。
 * schema 的叶子推导出这些名字 → 启动失败：一个变量不能既是引导变量又是配置项。
 */
export const BOOTSTRAP_ENV = ['NODE_ENV', 'DATA_DIR', 'SERVER_CONFIG'] as const

/** 叠哪一层环境文件：`NODE_ENV`，没设按 development（和 `config.ts` 的 `isDev` 同口径） */
const mode = process.env.NODE_ENV?.trim() || 'development'

const files = readConfigFiles({ dir: dataDir, mode, explicit: process.env.SERVER_CONFIG })

/**
 * 底座的段：import 时就解析（底座各处的配置常量在 import 时求值）。`modules` 段先原样放过 ——
 * 它长什么样要等模块清单交进来才知道，由 {@link resolveFullConfig} 再完整校验一遍。
 */
export const configSource = resolveConfig(coreConfigSchema, files, process.env, { deferred: ['modules'], reservedEnv: BOOTSTRAP_ENV })

/** 按路径取底座的一项（`cfg('server.port')`）：环境变量优先，其次配置文件；都没有 = undefined（由调用方给默认值） */
export function cfg(path: ConfigPath<typeof coreConfigSchema>): string | undefined {
  return configSource.get(path)
}

/** 完整的 schema：底座的段 + `modules`（模块清单里每个模块一节，各自带 `enabled`） */
export function serverConfigSchema(modules: readonly AnyServerModule[]): ConfigSchema {
  return { ...coreConfigSchema, modules: moduleConfigSchema(modules) }
}

/**
 * 交进模块清单之后的完整解析：整份文件按完整的 schema 再校验一次（拼错的 `modules.agent.modle` 在这里报），
 * 推导出的环境变量名在底座和全部模块之间唯一。模块的 `config.parse` 从它取值。
 */
export function resolveFullConfig(modules: readonly AnyServerModule[]): ConfigSource {
  return resolveConfig(serverConfigSchema(modules), files, process.env, { reservedEnv: BOOTSTRAP_ENV })
}
