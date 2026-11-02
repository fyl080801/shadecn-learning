import { defineEntity, type MikroORM, type Options, p } from '@mikro-orm/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openOrm, providerFromUrl } from '../src/orm.js'
import { findDataLoss, planSchemaSync, SchemaDataLossError, splitStatements, syncSchema } from '../src/schema-sync.js'
import { postgresFixture, sqliteFixture, type DatabaseFixture } from './helpers.js'

/**
 * 表结构同步的有损变更守卫（src/schema-sync.ts）。
 *
 * 前半段是纯函数：下面的 SQL 样本**都是 MikroORM 7.2.5 实际吐出来的**（拿一张探针表在两种库上
 * 分别做加列 / 删列 / 改类型 / 改可空 / 删表，`getUpdateSchemaSQL()` 原样抄下来），
 * 不是手写的「大概长这样」—— 守卫判的就是这些文本，样本错了测试就没有意义。
 * 这些样本和 `apps/server/test/db/schema-sync.test.ts` 是同一批，两边各有一份守卫。升 MikroORM 时两边都要重新采样。
 *
 * 后半段连真实的库（SQLite 临时文件；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL）。
 */

const SQLITE = {
  addColumnAndTable: [
    'create table `guard_extra` (`id` text not null primary key);',
    '',
    'alter table `guard_probe` add column `summary` text null;',
  ].join('\n'),
  addIndex: 'create index `guard_probe_note_index` on `guard_probe` (`note`);',
  dropIndex: 'drop index `guard_probe_label_index`;',
  dropColumn: 'alter table `guard_probe` drop column `note`;',
  // 改列类型：SQLite 不支持 alter column，MikroORM 走整表重建
  changeType: [
    'pragma foreign_keys = off;',
    "create table `guard_probe__temp_alter` (`id` text not null primary key, `label` text null, `count` text not null default '0', `note` text null, `owner_id` text null, `created_at` datetime not null, constraint `guard_probe_owner_id_foreign` foreign key (`owner_id`) references `user` (`id`) on delete cascade);",
    'insert into `guard_probe__temp_alter` select `id`, `label`, `count`, `note`, `owner_id`, `created_at` from `guard_probe`;',
    'drop table `guard_probe`;',
    'alter table `guard_probe__temp_alter` rename to `guard_probe`;',
    'create index `guard_probe_owner_id_index` on `guard_probe` (`owner_id`);',
    'create index `guard_probe_label_index` on `guard_probe` (`label`);',
    'pragma foreign_keys = on;',
  ].join('\n'),
  // 只是把一列改成可空，SQLite 照样整表重建 —— `safe: true` 挡不住的正是这条路
  makeNullable: [
    'pragma foreign_keys = off;',
    'create table `guard_probe__temp_alter` (`id` text not null primary key, `label` text null, `count` integer not null default 0, `note` text null, `owner_id` text null, `created_at` datetime null, constraint `guard_probe_owner_id_foreign` foreign key (`owner_id`) references `user` (`id`) on delete cascade);',
    'insert into `guard_probe__temp_alter` select `id`, `label`, `count`, `note`, `owner_id`, `created_at` from `guard_probe`;',
    'drop table `guard_probe`;',
    'alter table `guard_probe__temp_alter` rename to `guard_probe`;',
    'create index `guard_probe_owner_id_index` on `guard_probe` (`owner_id`);',
    'create index `guard_probe_label_index` on `guard_probe` (`label`);',
    'pragma foreign_keys = on;',
  ].join('\n'),
  dropTable: 'drop table if exists `guard_probe`;',
}

const POSTGRES = {
  addColumnAndTable: [
    "set names 'utf8';",
    '',
    'create table "guard_extra" ("id" text not null, primary key ("id"));',
    '',
    'alter table "guard_probe" add "summary" text null;',
  ].join('\n'),
  addIndex: ["set names 'utf8';", '', 'create index "guard_probe_note_index" on "guard_probe" ("note");'].join('\n'),
  dropIndex: ["set names 'utf8';", '', 'drop index "guard_probe_label_index";'].join('\n'),
  dropColumn: ["set names 'utf8';", '', 'alter table "guard_probe" drop column "note";'].join('\n'),
  changeType: [
    "set names 'utf8';",
    '',
    'alter table "guard_probe" alter column "count" type text using ("count"::text);',
    'alter table "guard_probe" alter column "count" set default \'0\';',
  ].join('\n'),
  setNotNull: [
    "set names 'utf8';",
    '',
    'alter table "guard_probe" alter column "label" set default \'\';',
    'alter table "guard_probe" alter column "label" set not null;',
  ].join('\n'),
  makeNullable: ["set names 'utf8';", '', 'alter table "guard_probe" alter column "created_at" drop not null;'].join('\n'),
  dropTable: ["set names 'utf8';", '', 'drop table if exists "guard_probe" cascade;'].join('\n'),
}

const kinds = (sql: string) => findDataLoss(sql).map((item) => item.kind)

describe('有损变更守卫：SQLite 的实际输出', () => {
  it('建表、加列、建索引、删索引都放行', () => {
    expect(findDataLoss(SQLITE.addColumnAndTable)).toEqual([])
    expect(findDataLoss(SQLITE.addIndex)).toEqual([])
    expect(findDataLoss(SQLITE.dropIndex)).toEqual([])
  })

  it('删列被拦下，并带着那一句', () => {
    expect(findDataLoss(SQLITE.dropColumn)).toEqual([
      { kind: '删列', statement: 'alter table `guard_probe` drop column `note`' },
    ])
  })

  it('改列类型走的整表重建被拦下 —— 夹在中间的 drop table 也算在重建里', () => {
    const found = kinds(SQLITE.changeType)
    expect(found).toContain('表重建')
    // 重建里的 create / insert / rename 都带着 __temp_alter，drop table 那句是「删表」
    expect(found).toEqual(['表重建', '表重建', '删表', '表重建'])
  })

  it('连只是改成可空也会整表重建，同样要 --force', () => {
    expect(kinds(SQLITE.makeNullable)).toContain('表重建')
  })

  it('删表被拦下', () => {
    expect(kinds(SQLITE.dropTable)).toEqual(['删表'])
  })
})

describe('有损变更守卫：PostgreSQL 的实际输出', () => {
  it('建表、加列、建索引、删索引都放行（set names 那句也不算）', () => {
    expect(findDataLoss(POSTGRES.addColumnAndTable)).toEqual([])
    expect(findDataLoss(POSTGRES.addIndex)).toEqual([])
    expect(findDataLoss(POSTGRES.dropIndex)).toEqual([])
  })

  it('删列被拦下', () => {
    expect(findDataLoss(POSTGRES.dropColumn)).toEqual([
      { kind: '删列', statement: 'alter table "guard_probe" drop column "note"' },
    ])
  })

  it('改列类型被拦下（safe: true 在 PG 上恰恰放过的就是这句），改默认值那句不算', () => {
    expect(findDataLoss(POSTGRES.changeType)).toEqual([
      {
        kind: '改列类型',
        statement: 'alter table "guard_probe" alter column "count" type text using ("count"::text)',
      },
    ])
  })

  it('改可空 / 非空、改默认值放行：失败了当场报错，不会悄悄丢数据', () => {
    expect(findDataLoss(POSTGRES.setNotNull)).toEqual([])
    expect(findDataLoss(POSTGRES.makeNullable)).toEqual([])
  })

  it('删表被拦下', () => {
    expect(kinds(POSTGRES.dropTable)).toEqual(['删表'])
  })
})

describe('有损变更守卫：其它写法', () => {
  it('列改名（MikroORM 的启发式改名判定可能是误判）和清数据也拦', () => {
    expect(kinds('alter table "a" rename column "x" to "y";')).toEqual(['改名'])
    expect(kinds('truncate table "a";\ndelete from "b";')).toEqual(['清数据', '清数据'])
  })

  it('大小写不影响判定', () => {
    expect(kinds('ALTER TABLE "a" DROP COLUMN "x";')).toEqual(['删列'])
    expect(kinds('ALTER TABLE "a" ALTER COLUMN "x" SET DATA TYPE text;')).toEqual(['改列类型'])
  })

  it('按「行尾分号」拆句，空行和末尾不带分号的都处理', () => {
    expect(splitStatements('a;\n\nb;\nc')).toEqual(['a', 'b', 'c'])
    expect(splitStatements('')).toEqual([])
  })
})

type Entities = NonNullable<Options['entities']>

/** 真实的库：先按原始定义建好（再写一行数据），再用改过的定义算差异 */
function onRealDatabase(createFixture: () => DatabaseFixture, provider: 'sqlite' | 'postgresql') {
  let fixture: DatabaseFixture
  let url: string
  const opened: MikroORM[] = []

  const open = async (entities: Entities) => {
    const orm = await openOrm({ provider: providerFromUrl(url) ?? 'sqlite', url, entities })
    opened.push(orm)
    return orm
  }

  function guardProbe(change: (properties: Record<string, unknown>) => void = () => undefined): Entities {
    const properties: Record<string, unknown> = {
      id: p.text().primary(),
      label: p.text().strictNullable(),
      note: p.text().default(''),
      createdAt: p.datetime(),
    }
    change(properties)
    return [defineEntity({ name: 'GuardProbe', properties })] as Entities
  }

  beforeAll(() => {
    fixture = createFixture()
  })
  afterAll(() => fixture.cleanup())

  beforeEach(async () => {
    url = await fixture.fresh()
    const orm = await open(guardProbe())
    await syncSchema(orm)
    await orm.driver
      .getConnection()
      .execute(`insert into guard_probe (id, label, note, created_at) values ('row', null, '还在', '2020-01-01T00:00:00.000Z')`)
  })
  afterEach(async () => {
    while (opened.length > 0) await opened.pop()?.close()
  })

  const rows = async () => (await open(guardProbe())).driver.getConnection().execute('select id, note from guard_probe')

  it('实体定义和建出来的库一致：再同步一次没有任何语句', async () => {
    // 这条红了说明某个实体写法会让 MikroORM 每次都算出差异 —— 那样每次启动都会被守卫拦下
    const plan = await planSchemaSync(await open(guardProbe()))
    expect(plan.statements).toEqual([])
    expect(plan.dataLoss).toEqual([])
    expect((await syncSchema(await open(guardProbe()))).applied).toBe(false)
  })

  it('删掉一个字段 → 守卫拒绝执行，并报出删列语句，一句没执行', async () => {
    const orm = await open(guardProbe((properties) => delete properties.note))

    const plan = await planSchemaSync(orm)
    expect(plan.dataLoss.map((item) => item.kind)).toEqual(['删列'])
    expect(plan.dataLoss[0].statement).toMatch(/guard_probe.*drop column.*note/)

    await expect(syncSchema(orm)).rejects.toBeInstanceOf(SchemaDataLossError)
    expect((await planSchemaSync(await open(guardProbe()))).statements).toEqual([])
    expect(await rows()).toEqual([{ id: 'row', note: '还在' }])
  })

  it(`改一个字段的类型 → PG 报改列类型，SQLite 报整表重建（${provider}）`, async () => {
    const orm = await open(guardProbe((properties) => (properties.note = p.integer().default(0))))

    const found = (await planSchemaSync(orm)).dataLoss.map((item) => item.kind)
    expect(found).toContain(provider === 'postgresql' ? '改列类型' : '表重建')
    await expect(syncSchema(orm)).rejects.toBeInstanceOf(SchemaDataLossError)
    expect(await rows()).toEqual([{ id: 'row', note: '还在' }])
  })

  it('只加一列是放行的，而且真的加上了，数据还在', async () => {
    const orm = await open(guardProbe((properties) => (properties.extra = p.text().strictNullable())))
    const plan = await planSchemaSync(orm)
    expect(plan.statements.some((statement) => /add (column )?.?extra/.test(statement))).toBe(true)
    expect(plan.dataLoss).toEqual([])

    expect((await syncSchema(orm)).applied).toBe(true)
    expect((await planSchemaSync(orm)).statements).toEqual([])
    expect(await rows()).toEqual([{ id: 'row', note: '还在' }])
  })

  it('实体之外的表：列进 unmanagedTables，不进要执行的语句和有损清单；它们之间的外键也不动', async () => {
    const orm = await open(guardProbe())
    await orm.schema.execute('create table outside_parent (id text primary key)')
    await orm.schema.execute('create table outside_child (id text primary key, parent_id text references outside_parent (id))')
    for (let round = 0; round < 2; round++) {
      // 算两遍：skipTables 算完要还原，否则第二遍认不出这些表
      const plan = await planSchemaSync(orm)
      expect([...plan.unmanagedTables].sort()).toEqual(['outside_child', 'outside_parent'])
      expect(plan.statements).toEqual([])
      expect(plan.dataLoss).toEqual([])
    }
    expect(orm.config.get('schemaGenerator').skipTables ?? []).toEqual([])
  })
}

describe('在真实的库上算差异（SQLite）', () => {
  onRealDatabase(sqliteFixture, 'sqlite')
})

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

describe.skipIf(!postgresUrl)('在真实的库上算差异（PostgreSQL，PLATFORM_TEST_DATABASE_URL）', () => {
  onRealDatabase(() => postgresFixture(postgresUrl as string), 'postgresql')
})
