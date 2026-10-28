import { defineEntity, p } from '@mikro-orm/core'
import { afterEach, describe, expect, it } from 'vitest'
import { dbProvider } from '../../config.ts'
import { AuthRequest, entities } from '../../db/entities/index.ts'
import { createOrm } from '../../db/orm.ts'
import {
  SchemaDataLossError,
  findDataLoss,
  planSchemaSync,
  splitStatements,
  syncSchema,
} from '../../db/schema-sync.ts'

/**
 * 表结构同步的有损变更守卫（apps/server/db/schema-sync.ts）。
 *
 * 前半段是纯函数：下面的 SQL 样本**都是 MikroORM 7.2.5 实际吐出来的**（拿一张探针表在两种库上
 * 分别做加列 / 删列 / 改类型 / 改可空 / 删表，`getUpdateSchemaSQL()` 原样抄下来），
 * 不是手写的「大概长这样」—— 守卫判的就是这些文本，样本错了测试就没有意义。
 *
 * 后半段连着真实的测试库（SQLite 或 PostgreSQL，看 TEST_DATABASE_URL）：只算不执行，
 * 不改测试库的结构，跑完库还是 global-setup 建出来的样子。
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

describe('在真实测试库上算差异（只算不执行）', () => {
  const opened: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    while (opened.length > 0) await opened.pop()?.close()
  })

  async function open(entitySet?: Parameters<typeof createOrm>[0]) {
    const orm = await createOrm(entitySet)
    opened.push(orm)
    return orm
  }

  /** 把 AuthRequest 换成一份改过的定义（它不被别的实体引用，换掉它不牵连外键） */
  function withAuthRequest(change: (properties: Record<string, unknown>) => void) {
    const properties: Record<string, unknown> = {
      id: p.text().primary(),
      state: p.text().unique(),
      nonce: p.text(),
      codeVerifier: p.text(),
      provider: p.text().default('keycloak'),
      linkUserId: p.text().strictNullable(),
      redirectTo: p.text().default('/'),
      origin: p.text().default(''),
      createdAt: p.datetime(),
      expiresAt: p.datetime(),
    }
    change(properties)
    const changed = defineEntity({ name: 'AuthRequest', properties })
    return { entities: entities.map((entity) => (entity === AuthRequest ? changed : entity)) }
  }

  it('实体定义和 global-setup 建出来的库一致：再同步一次没有任何语句', async () => {
    // 这条红了说明某个实体写法会让 MikroORM 每次都算出差异 —— 那样每次启动都会被守卫拦下
    const plan = await planSchemaSync(await open())
    expect(plan.statements).toEqual([])
    expect(plan.dataLoss).toEqual([])
  })

  it(`删掉一个字段 → 守卫拒绝执行，并报出删列语句（${dbProvider}）`, async () => {
    const orm = await open(withAuthRequest((properties) => delete properties.origin))

    const plan = await planSchemaSync(orm)
    expect(plan.dataLoss.map((item) => item.kind)).toEqual(['删列'])
    expect(plan.dataLoss[0].statement).toMatch(/auth_request.*drop column.*origin/)

    await expect(syncSchema(orm)).rejects.toBeInstanceOf(SchemaDataLossError)
    // 一句都没执行：库还是原样
    expect((await planSchemaSync(await open())).statements).toEqual([])
  })

  it(`改一个字段的类型 → PG 报改列类型，SQLite 报整表重建（${dbProvider}）`, async () => {
    const orm = await open(withAuthRequest((properties) => (properties.origin = p.integer().default(0))))

    const found = (await planSchemaSync(orm)).dataLoss.map((item) => item.kind)
    expect(found).toContain(dbProvider === 'postgresql' ? '改列类型' : '表重建')
    await expect(syncSchema(orm)).rejects.toBeInstanceOf(SchemaDataLossError)
  })

  it('只加一列是放行的（这里只看判定，不真的加）', async () => {
    const orm = await open(
      withAuthRequest((properties) => (properties.note = p.text().strictNullable())),
    )
    const plan = await planSchemaSync(orm)
    expect(plan.statements.some((statement) => /add (column )?.?note/.test(statement))).toBe(true)
    expect(plan.dataLoss).toEqual([])
  })
})
