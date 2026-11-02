import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testConfigModule } from '@learning/config/testing'
import { defineEntity, type EntityManager, MikroORM, p } from '@mikro-orm/core'
import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { DataAccess, DataAccessModule, User } from '../src/index.js'
import { planSchemaSync, SchemaDataLossError } from '../src/schema-sync.js'
import {
  boot,
  databaseConfig,
  dataAccessWith,
  inspect,
  postgresFixture,
  sqliteFixture,
  tableNames,
  type DatabaseFixture,
} from './helpers.js'

function newUser(em: EntityManager, subject: string) {
  return em.create(User, {
    issuer: 'https://issuer.test',
    subject,
    username: null,
    email: null,
    name: null,
    avatarUrl: null,
    roles: '[]',
    lastLoginAt: null,
  })
}

/** 典型的消费者：构造函数按类型注入，所在模块不 import DataAccessModule（靠 global） */
@Injectable()
class UserStore {
  constructor(private readonly dataAccess: DataAccess) {}

  async add(subject: string): Promise<string> {
    const em = this.dataAccess.em()
    const user = newUser(em, subject)
    await em.flush()
    return user.id
  }

  findSubject(id: string) {
    return this.dataAccess.em().findOne(User, id).then((user) => user?.subject)
  }
}

@Module({ providers: [UserStore], exports: [UserStore] })
class UserStoreModule {}

// 探针实体：V2 删掉 note（有损）的同时加了 extra（放行类）。守卫拒绝时加列也不该执行
const ProbeV1 = defineEntity({
  name: 'GuardProbe',
  properties: { id: p.text().primary(), note: p.text() },
})
const ProbeV2 = defineEntity({
  name: 'GuardProbe',
  properties: { id: p.text().primary(), extra: p.text().nullable() },
})

/** 两种库跑同一组行为 */
function behaviours(createFixture: () => DatabaseFixture) {
  let fixture: DatabaseFixture
  let url: string
  let logSpy: MockInstance<typeof console.log>
  let errorSpy: MockInstance<typeof console.error>
  let warnSpy: MockInstance<typeof console.warn>

  const printed = (spy: MockInstance<(...args: never[]) => void>) => spy.mock.calls.map((call) => String(call[0])).join('\n')

  beforeAll(() => {
    fixture = createFixture()
  })
  afterAll(() => fixture.cleanup())

  beforeEach(async () => {
    url = await fixture.fresh()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('首次启动：执行建表语句并打印，没有模块登记时只有 user 表；二次启动：无语句', async () => {
    const first = await boot([databaseConfig(url), DataAccessModule])
    expect(printed(logSpy)).toMatch(/\[data-access\] 已同步表结构/)
    expect(printed(logSpy).toLowerCase()).toContain('create table')
    const orm = first.get(DataAccess).orm
    expect(await tableNames(orm)).toEqual(['user'])
    await first.close()

    logSpy.mockClear()
    const second = await boot([databaseConfig(url), DataAccessModule])
    expect(printed(logSpy)).toMatch(/\[data-access\] 表结构已与实体定义一致.*无需变更/)
    expect(printed(logSpy).toLowerCase()).not.toContain('create table')
    await second.close()
  })

  it('消费者模块经 DI 拿到 DataAccess 并完成增查，不用 import DataAccessModule', async () => {
    const app = await boot([UserStoreModule, databaseConfig(url), DataAccessModule])
    const store = app.get(UserStore)
    const id = await store.add('alice')
    expect(await store.findSubject(id)).toBe('alice')
    await app.close()
  })

  it('em() 每次 fork：身份映射互不相通', async () => {
    const app = await boot([databaseConfig(url), DataAccessModule])
    const dataAccess = app.get(DataAccess)
    expect(dataAccess.em()).not.toBe(dataAccess.em())
    expect(dataAccess.em().id).not.toBe(dataAccess.orm.em.id)
    await app.close()
  })

  it('transactional：正常返回则提交，抛错则回滚且原样抛出', async () => {
    const app = await boot([databaseConfig(url), DataAccessModule])
    const dataAccess = app.get(DataAccess)

    await dataAccess.transactional(async (em) => {
      newUser(em, 'kept')
    })
    const boom = new Error('故意的')
    await expect(
      dataAccess.transactional(async (em) => {
        newUser(em, 'rolled-back')
        await em.flush()
        throw boom
      }),
    ).rejects.toBe(boom)

    const subjects = (await dataAccess.em().findAll(User)).map((user) => user.subject)
    expect(subjects).toEqual(['kept'])
    await app.close()
  })

  it('顺序不变式：同步先于任何消费者 —— 排在前面的普通 / 全局 / 深层模块的 onModuleInit、异步工厂都查得到表', async () => {
    const seen: string[] = []

    const consumer = (name: string) => {
      @Injectable()
      class Consumer implements OnModuleInit {
        constructor(readonly dataAccess: DataAccess) {}
        async onModuleInit() {
          await this.dataAccess.em().count(User)
          seen.push(`${name}.onModuleInit`)
        }
      }
      return Consumer
    }

    @Module({ providers: [consumer('deep')] })
    class DeepModule {}
    @Module({ imports: [DeepModule] })
    class MidModule {}
    @Module({ providers: [consumer('plain')] })
    class PlainModule {}
    @Global()
    @Module({ providers: [consumer('global')] })
    class EarlyGlobalModule {}
    @Module({
      providers: [
        {
          provide: 'FACTORY',
          inject: [DataAccess],
          useFactory: async (dataAccess: DataAccess) => {
            await dataAccess.em().count(User)
            seen.push('factory')
            return true
          },
        },
      ],
    })
    class FactoryModule {}

    const app = await boot([MidModule, PlainModule, EarlyGlobalModule, FactoryModule, databaseConfig(url), DataAccessModule])
    expect([...seen].sort()).toEqual(['deep.onModuleInit', 'factory', 'global.onModuleInit', 'plain.onModuleInit'])
    await app.close()
  })

  it('有损变更拒绝启动：抛 SchemaDataLossError，一句不执行（连同一批的加列也不执行），ORM 已关', async () => {
    const first = await boot([databaseConfig(url), dataAccessWith([ProbeV1])])
    const em = first.get(DataAccess).em()
    em.create(ProbeV1, { id: 'row', note: '还在' })
    await em.flush()
    await first.close()

    const closeSpy = vi.spyOn(MikroORM.prototype, 'close')
    await expect(boot([databaseConfig(url), dataAccessWith([ProbeV2])])).rejects.toBeInstanceOf(SchemaDataLossError)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(printed(errorSpy)).toMatch(/\[data-access\] 表结构同步失败/)
    closeSpy.mockRestore()

    // 库还是 V1 的样子：按 V1 比对没有差异，数据也在
    const orm = await inspect(url, [ProbeV1])
    expect((await planSchemaSync(orm)).statements).toEqual([])
    expect((await orm.em.fork().findOneOrFail(ProbeV1, 'row')).note).toBe('还在')
    await orm.close()
  })

  it('实体之外的表：只提醒，不动', async () => {
    const seed = await inspect(url, [ProbeV1])
    await seed.schema.execute(`create table outside_entities (id text primary key)`)
    await seed.close()

    const app = await boot([databaseConfig(url), DataAccessModule])
    expect(printed(warnSpy)).toMatch(/\[data-access\] 库里有 1 张实体之外的表.*outside_entities/)
    expect(await tableNames(app.get(DataAccess).orm)).toContain('outside_entities')
    await app.close()
  })

  it('实体被移出实体集：一句都不执行（外键也不动），只提醒，数据还在；放回来之后差异为空', async () => {
    // 模拟 canvas 这类实体从 platform 拿走之后的旧库：子表 → 父表 → user。
    // 实测 MikroORM 算差异时即使 dropTables: false 也会在 PG 上删掉指向「模型之外的表」的外键，见 schema-sync.ts
    const Parent = defineEntity({
      name: 'ParentProbe',
      properties: { id: p.text().primary(), owner: () => p.manyToOne(User).deleteRule('cascade') },
    })
    const Child = defineEntity({
      name: 'ChildProbe',
      properties: { id: p.text().primary(), parent: () => p.manyToOne(Parent).deleteRule('cascade') },
    })
    const first = await boot([databaseConfig(url), dataAccessWith([User, Parent, Child])])
    const seed = first.get(DataAccess).em()
    const owner = newUser(seed, 'owner')
    const parent = seed.create(Parent, { id: 'p', owner })
    seed.create(Child, { id: 'c', parent })
    await seed.flush()
    await first.close()

    warnSpy.mockClear()
    logSpy.mockClear()
    const app = await boot([databaseConfig(url), DataAccessModule])
    expect(printed(logSpy)).toMatch(/\[data-access\] 表结构已与实体定义一致.*无需变更/)
    expect(printed(logSpy)).not.toMatch(/已同步表结构/)
    expect(printed(warnSpy)).toMatch(/\[data-access\] 库里有 2 张实体之外的表.*child_probe, parent_probe/)
    const connection = app.get(DataAccess).orm.driver.getConnection()
    expect(await connection.execute('select id from child_probe')).toEqual([{ id: 'c' }])
    await app.close()

    // 模块带着实体回来：外键一条没少，没有差异
    const restored = await boot([databaseConfig(url), dataAccessWith([User, Parent, Child])])
    expect(await restored.get(DataAccess).orm.schema.getUpdateSchemaSQL({ dropTables: false })).toBe('')
    await restored.close()
  })

  it('关闭：ORM 已断开；关两次不出错、只真正关一次；消费者的 onModuleDestroy 还能查库', async () => {
    let countAtDestroy: number | undefined

    @Injectable()
    class Flusher implements OnModuleDestroy {
      constructor(readonly dataAccess: DataAccess) {}
      async onModuleDestroy() {
        countAtDestroy = await this.dataAccess.em().count(User)
      }
    }
    @Module({ providers: [Flusher] })
    class FlusherModule {}

    const app = await boot([FlusherModule, databaseConfig(url), DataAccessModule])
    const dataAccess = app.get(DataAccess)
    const closeSpy = vi.spyOn(dataAccess.orm, 'close')

    await app.close()
    expect(countAtDestroy).toBe(0)
    expect(await dataAccess.orm.isConnected()).toBe(false)

    await app.close()
    await dataAccess.onApplicationShutdown()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
}

describe('DataAccessModule（SQLite）', () => {
  behaviours(sqliteFixture)

  it('连接串协议不认识 → 启动失败，报错里不带连接串', async () => {
    const failure = boot([databaseConfig('mysql://user:secret@127.0.0.1/db'), DataAccessModule])
    await expect(failure).rejects.toThrow('连接串的协议不认识')
    await expect(failure).rejects.not.toThrow('secret')
  })
})

describe('database 配置段', () => {
  let dir: string
  const probe = () => dataAccessWith([ProbeV1])
  const paths = () => ({ rootDir: dir, dataDir: path.join(dir, 'some-data-dir') })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-access-config-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([
    ['没写这一段', {}],
    ['写了空段', { database: null }],
    ['url 留空', { database: { url: '  ' } }],
  ])('%s → <dataDir>/platform.db', async (_name, values) => {
    const app = await boot([testConfigModule(values, paths()), probe()])
    await app.close()
    expect(fs.existsSync(path.join(dir, 'some-data-dir/platform.db'))).toBe(true)
  })

  it('PLATFORM_DATABASE_URL 优先于 database.url', async () => {
    const fromEnv = path.join(dir, 'from-env.db')
    const fromFile = path.join(dir, 'from-file.db')
    const app = await boot([
      testConfigModule(
        { database: { url: `file:${fromFile}` } },
        { ...paths(), env: { PLATFORM_DATABASE_URL: `file:${fromEnv}` } },
      ),
      probe(),
    ])
    await app.close()
    expect(fs.existsSync(fromEnv)).toBe(true)
    expect(fs.existsSync(fromFile)).toBe(false)
  })

  it('不读进程的 DATABASE_URL：只经 ConfigService 取', async () => {
    const elsewhere = path.join(dir, 'elsewhere.db')
    vi.stubEnv('DATABASE_URL', `file:${elsewhere}`)
    vi.stubEnv('PLATFORM_DATABASE_URL', `file:${elsewhere}`)
    const app = await boot([testConfigModule({}, paths()), probe()])
    await app.close()
    expect(fs.existsSync(path.join(dir, 'some-data-dir/platform.db'))).toBe(true)
    expect(fs.existsSync(elsewhere)).toBe(false)
  })

  it('相对的 file: 按 rootDir 解析，不随 cwd 变', async () => {
    const app = await boot([testConfigModule({ database: { url: 'file:nested/custom.db' } }, paths()), probe()])
    await app.close()
    expect(fs.existsSync(path.join(dir, 'nested/custom.db'))).toBe(true)
  })

  it.each([
    ['url 不是字符串', { database: { url: 12345 } }, 'database.url 必须是字符串'],
    ['这一段不是映射', { database: 'file:x.db' }, 'database 段必须是映射'],
  ])('%s → 启动失败', async (_name, values, message) => {
    await expect(boot([testConfigModule(values, paths()), probe()])).rejects.toThrow(message)
  })

  it('缺 ConfigModule → 依赖解析错误，点名 ConfigService', async () => {
    await expect(boot([DataAccessModule])).rejects.toThrow(/can't resolve dependencies[\s\S]*ConfigService/)
  })
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('DataAccessModule（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  behaviours(() => postgresFixture(postgresUrl as string))

  it('连接串里的 ?schema= 摘出来交给 MikroORM：表建在那个 schema 里', async () => {
    const url = await postgresFixture(postgresUrl as string).fresh()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const app = await boot([databaseConfig(`${url}?schema=data_access_probe`), dataAccessWith([ProbeV1])])
    const rows = (await app
      .get(DataAccess)
      .orm.driver.getConnection()
      .execute(`select schemaname from pg_tables where tablename = 'guard_probe'`)) as { schemaname: string }[]
    expect(rows.map((row) => row.schemaname)).toEqual(['data_access_probe'])
    await app.close()

    const cleanup = await inspect(url)
    await cleanup.driver.getConnection().execute('drop schema data_access_probe cascade')
    await cleanup.close()
    log.mockRestore()
  })

  it('别的 schema 里有同名表：自己的表照样建（skipTables 只按表名匹配，不能把它排除掉）', async () => {
    const url = await postgresFixture(postgresUrl as string).fresh()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seed = await inspect(url)
    const connection = seed.driver.getConnection()
    await connection.execute('create schema if not exists data_access_other')
    await connection.execute('create table data_access_other."user" (id text primary key)')
    await seed.close()

    try {
      const app = await boot([databaseConfig(url), DataAccessModule])
      const rows = await app.get(DataAccess).orm.driver.getConnection().execute(`select count(*)::int as n from public."user"`)
      expect(rows).toEqual([{ n: 0 }])
      await app.close()
    } finally {
      const cleanup = await inspect(url)
      await cleanup.driver.getConnection().execute('drop schema data_access_other cascade')
      await cleanup.close()
      log.mockRestore()
    }
  })

  it('连接串带 ?schema= 时也认得出模型之外的表（语句里的表名带 schema 前缀）：外键不动，名字报对', async () => {
    const url = await postgresFixture(postgresUrl as string).fresh()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const Parent = defineEntity({ name: 'ParentProbe', properties: { id: p.text().primary() } })
    const Child = defineEntity({
      name: 'ChildProbe',
      properties: { id: p.text().primary(), parent: () => p.manyToOne(Parent).deleteRule('cascade') },
    })
    const scoped = `${url}?schema=data_access_scoped`

    const first = await boot([databaseConfig(scoped), dataAccessWith([User, Parent, Child])])
    await first.close()

    log.mockClear()
    try {
      const app = await boot([databaseConfig(scoped), DataAccessModule])
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/无需变更/)
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/2 张实体之外的表.*child_probe, parent_probe/)
      await app.close()
    } finally {
      const cleanup = await inspect(url)
      await cleanup.driver.getConnection().execute('drop schema data_access_scoped cascade')
      await cleanup.close()
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
