import path from 'node:path'
import { ConfigService } from '@learning/config'
import type { MikroORM } from '@mikro-orm/core'
import { Global, Module } from '@nestjs/common'
import { ModulesContainer } from '@nestjs/core'
import { DATA_ACCESS_ORM, DataAccess } from './data-access.js'
import { User } from './entities.js'
import { collectEntities, DATA_ACCESS_ENTITIES, DATA_ACCESS_ENTITY_OVERRIDE, type Entities } from './entity-registry.js'
import { type DbProvider, openOrm, providerFromUrl } from './orm.js'
import { syncSchema } from './schema-sync.js'

/**
 * 连接串：运行目录 .env（或环境变量）的 `PLATFORM_DATABASE_URL`，带密码的放这里；否则 config.yaml 的 `database.url`。
 * PostgreSQL 连接串，或 SQLite 的 `file:<路径>`（相对路径按仓库根，不随 cwd 变）。
 * 都没写或留空 = `<dataDir>/platform.db`。不读 `DATABASE_URL`：那是另一个服务（`apps/server`）的库，这里启动时会同步表结构。
 */
function databaseUrl(config: ConfigService): string {
  const url = config.env('PLATFORM_DATABASE_URL') ?? config.mapping('database').url
  if (url === undefined || url === null) return `file:${path.join(config.dataDir, 'platform.db')}`
  // 不把值打出来：里面可能有密码
  if (typeof url !== 'string') throw new Error('[data-access] database.url 必须是字符串')
  const trimmed = url.trim()
  if (!trimmed) return `file:${path.join(config.dataDir, 'platform.db')}`
  return trimmed.startsWith('file:') ? `file:${config.resolvePath(trimmed.slice('file:'.length))}` : trimmed
}

/** 这个进程连的是哪种库。别的模块的规则要用（`redis` 不能配 SQLite），不用等 ORM 建好。连接串协议不认识时是 undefined，ORM 工厂会拒绝启动 */
export function databaseProviderOf(config: ConfigService): DbProvider | undefined {
  return providerFromUrl(databaseUrl(config))
}

type SchemaSyncMode = 'apply' | 'off'

/**
 * `database.schemaSync`：`apply`（默认）启动时同步表结构，`off` 只连库不同步，给 HPA 副本用（多个进程同时跑 DDL 会撞车，由一个 `apply` 的进程负责）。
 * 写错了拒绝启动：`off` 拼错被当成默认值，副本就会去改表。
 */
function schemaSyncMode(config: ConfigService): SchemaSyncMode {
  const mode = config.mapping('database').schemaSync ?? 'apply'
  if (mode !== 'apply' && mode !== 'off') throw new Error('[data-access] database.schemaSync 只能是 apply 或 off')
  return mode
}

/**
 * `off` 也要验证连得上（`.claude/rules/database.md` 的约定）：`MikroORM.init()` 不连库，不验证的话要到第一个请求才知道，探针却一路是好的。
 * 只跑 `select 1`，不产生任何 DDL。
 */
async function openWithoutSync(orm: MikroORM, provider: DbProvider): Promise<MikroORM> {
  try {
    await orm.connect()
    const check = await orm.checkConnection()
    if (!check.ok) throw new Error(check.reason)
    console.log(`[data-access] 不同步表结构（database.schemaSync: off，${provider}: ${orm.config.get('dbName')}）`)
    return orm
  } catch (err) {
    console.error(`[data-access] 连不上数据库，中止启动：${err instanceof Error ? err.message : String(err)}`)
    await orm.close().catch(() => undefined)
    throw err
  }
}

/**
 * 建 ORM + 同步表结构。放在 ORM provider 的异步工厂里，**不放 onModuleInit**，实测（Nest 12.3.2）onModuleInit 给不了这个保证：
 * - 全局模块之间的钩子按注册顺序跑：排在 DataAccessModule 前面的全局业务模块，它的 onModuleInit 先于同步执行；
 * - 所有 provider 的工厂、构造函数都在任何 onModuleInit 之前：业务模块在异步工厂里查库，碰到的是还没建的表。
 * 工厂走的是依赖图：`DataAccess` 依赖这个 token，token 解析完才能注入，「拿得到 DataAccess」本身就等于「表已对齐」，和模块在 imports 里的位置无关。
 *
 * 失败的走向也因此变了：工厂抛错发生在 `NestFactory.create` 内部，默认的 `abortOnError` 下 Nest 记一条错误后 `process.exit(1)`，
 * 不会给 `main.ts` 一个 rejected promise。所以 ORM 要在这里先关掉（连接不留到 exit），错误也先打一条 —— 关了 Nest 日志时它是唯一的线索。
 *
 * 不接受 `force`：启动路径永远不放行有损变更（SchemaDataLossError = 启动失败，一句不执行），宁可起不来也不静默丢数据。
 */
async function openStartupOrm(config: ConfigService, entities: Entities): Promise<MikroORM> {
  const url = databaseUrl(config)
  const mode = schemaSyncMode(config)
  const provider = providerFromUrl(url)
  // 不把连接串打出来：里面有密码
  if (!provider) throw new Error('[data-access] 连接串的协议不认识（只支持 postgres:// / postgresql:// / file:）')

  const orm = await openOrm({ provider, url, entities })
  if (mode === 'off') return openWithoutSync(orm, provider)
  try {
    const result = await syncSchema(orm)
    const target = `${provider}: ${orm.config.get('dbName')}`
    if (result.applied) {
      console.log(`[data-access] 已同步表结构（${target}），执行了 ${result.statements.length} 句：`)
      for (const statement of result.statements) console.log(`  ${statement}`)
    } else {
      console.log(`[data-access] 表结构已与实体定义一致（${target}），无需变更`)
    }
    if (result.unmanagedTables.length > 0) {
      console.warn(
        `[data-access] 库里有 ${result.unmanagedTables.length} 张实体之外的表，没有动它们：${result.unmanagedTables.join(', ')}`,
      )
    }
    return orm
  } catch (err) {
    console.error(`[data-access] 表结构同步失败，中止启动：${err instanceof Error ? err.message : String(err)}`)
    await orm.close().catch(() => undefined)
    throw err
  }
}

/**
 * 数据访问模块：在根模块 import 一次，别的模块不用 import 就能注入 {@link DataAccess}。
 * 连接串经全局的 `ConfigService` 取（`@learning/config`）；这里不 import ConfigModule，测试才能换掉它。
 * 管理哪些实体由各模块登记（`DATA_ACCESS_ENTITIES`，见 entity-registry.ts），本模块自己登记 `User`：它是所有模块的外键目标。
 */
@Global()
@Module({
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [User] },
    { provide: DATA_ACCESS_ENTITY_OVERRIDE, useValue: null },
    {
      provide: DATA_ACCESS_ORM,
      inject: [ConfigService, ModulesContainer, DATA_ACCESS_ENTITY_OVERRIDE],
      useFactory: (config: ConfigService, modules: ModulesContainer, override: Entities | null) =>
        openStartupOrm(config, override ?? collectEntities(modules)),
    },
    DataAccess,
  ],
  exports: [DataAccess],
})
export class DataAccessModule {}
