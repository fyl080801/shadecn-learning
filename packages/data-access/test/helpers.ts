import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testConfigModule } from '@learning/config/testing'
import type { DynamicModule, INestApplicationContext, ModuleMetadata } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { openOrm, providerFromUrl } from '@shadecn/server-kit/orm'
import { defineEntity, p, type MikroORM, type Options } from '@mikro-orm/core'
import { DATA_ACCESS_ENTITIES } from '../src/data-access.js'
import { DataAccessModule } from '../src/module.js'

@Module({})
class Root {}

/** 走真实启动路径（工厂 + 全部生命周期钩子）。abortOnError: false：启动失败时拿到 rejected promise，而不是测试进程被 exit(1) */
export function boot(imports: NonNullable<ModuleMetadata['imports']>): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext({ module: Root, imports }, { logger: false, abortOnError: false })
}

/** 连接串写进配置，走和生产一样的 `database.url` */
export const databaseConfig = (url: unknown): DynamicModule => testConfigModule({ database: { url } })

/**
 * 换掉要管理的实体：同一个模块、同一个 ORM 工厂，只是 DATA_ACCESS_ENTITIES 换了值（动态元数据的 provider 排在静态的后面，同 token 后者生效）。
 * 用工厂而不是 useValue：动态元数据要算哈希，实体对象又深又有环。
 */
export const dataAccessWith = (entities: NonNullable<Options['entities']>): DynamicModule => ({
  module: DataAccessModule,
  providers: [{ provide: DATA_ACCESS_ENTITIES, useFactory: () => entities }],
})

// MikroORM 不接受空实体集；只想拿连接跑 SQL 时用这个占位，它的表不会被建
const Placeholder = defineEntity({ name: 'Placeholder', properties: { id: p.text().primary() } })

/** 绕开被测模块直接开一个 ORM，用来看库的真实状态 */
export function inspect(url: string, entities: NonNullable<Options['entities']> = [Placeholder]): Promise<MikroORM> {
  return openOrm({ provider: providerFromUrl(url) ?? 'sqlite', url, entities })
}

export async function tableNames(orm: MikroORM): Promise<string[]> {
  const sql =
    orm.driver.constructor.name === 'PostgreSqlDriver'
      ? `select tablename as name from pg_tables where schemaname = 'public'`
      : `select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`
  const rows = (await orm.driver.getConnection().execute(sql)) as { name: string }[]
  return rows.map((row) => row.name)
}

/** 一个库：`fresh()` 给一个空库的连接串 */
export interface DatabaseFixture {
  fresh(): Promise<string>
  cleanup(): Promise<void>
}

export function sqliteFixture(): DatabaseFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-access-'))
  let index = 0
  return {
    fresh: async () => `file:${path.join(dir, `nested/${index++}/test.db`)}`,
    cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * PostgreSQL 的 `fresh()` 会把 public schema 整个删掉重建，所以连接串**必须是专用库**：库名同时带 platform 和 test 才肯动，
 * 手滑指到 app / app_test 之类的库时测试直接失败，不会清掉别人的数据。
 */
export function postgresFixture(url: string): DatabaseFixture {
  const database = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!/platform/.test(database) || !/test/.test(database)) {
    throw new Error(`[data-access 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test（表会被重置），收到的是 ${database}`)
  }
  return {
    fresh: async () => {
      const orm = await inspect(url)
      await orm.driver.getConnection().execute('drop schema public cascade')
      await orm.driver.getConnection().execute('create schema public')
      await orm.close()
      return url
    },
    // 收尾也清一遍：跑完这个库留空
    cleanup: async () => {
      const orm = await inspect(url)
      await orm.driver.getConnection().execute('drop schema public cascade')
      await orm.driver.getConnection().execute('create schema public')
      await orm.close()
    },
  }
}
