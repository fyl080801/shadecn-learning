import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testConfigModule } from '@learning/config/testing'
import { AuthRequest, DataAccess, DataAccessModule, Session, User } from '@learning/data-access'
import type { DynamicModule, INestApplicationContext, ModuleMetadata } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

@Module({})
class Root {}

export function bootContext(imports: NonNullable<ModuleMetadata['imports']>): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext({ module: Root, imports }, { logger: false, abortOnError: false })
}

/** 库和会话配置写进配置，走和生产一样的 config.yaml 各段 */
export function sessionConfig(
  url: string,
  { secret, ...session }: { secret?: string } & Record<string, unknown>,
  options?: { isProduction?: boolean },
): DynamicModule {
  return testConfigModule({ database: { url }, session }, { ...options, env: { PLATFORM_SESSION_SECRET: secret } })
}

/** 两种库共用：`url` 在 `open()` 之后可用，`clear()` 清空用到的表，`dispose()` 收尾不留东西 */
export interface DatabaseFixture {
  readonly url: string
  open(): Promise<void>
  clear(): Promise<void>
  dispose(): Promise<void>
}

export function sqliteFixture(): DatabaseFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'))
  return fixture(`file:${path.join(dir, 'test.db')}`, () => {
    fs.rmSync(dir, { recursive: true, force: true })
    return Promise.resolve()
  })
}

/**
 * PostgreSQL 用独立的 schema，不碰 public：`pnpm test` 里 data-access 的用例同时在重置 public。
 * 收尾时删掉这个 schema。库名同时带 platform 和 test 才肯动，防止手滑指到别人的库。
 */
const POSTGRES_SCHEMA = 'session_test'

export function postgresFixture(baseUrl: string): DatabaseFixture {
  const database = decodeURIComponent(new URL(baseUrl).pathname.slice(1))
  if (!/platform/.test(database) || !/test/.test(database)) {
    throw new Error(`[session 测试] PLATFORM_TEST_DATABASE_URL 的库名必须同时带 platform 和 test，收到的是 ${database}`)
  }
  const fx: DatabaseFixture = fixture(`${baseUrl}?schema=${POSTGRES_SCHEMA}`, undefined, async (admin) => {
    await admin.orm.schema.execute(`drop schema if exists ${POSTGRES_SCHEMA} cascade`)
  })
  return fx
}

function fixture(
  url: string,
  afterClose?: () => Promise<void>,
  beforeClose?: (admin: DataAccess) => Promise<void>,
): DatabaseFixture {
  let admin: INestApplicationContext | undefined
  return {
    url,
    async open() {
      admin = await bootContext([testConfigModule({ database: { url } }), DataAccessModule])
    },
    async clear() {
      const em = (admin as INestApplicationContext).get(DataAccess).em()
      await em.nativeDelete(AuthRequest, {})
      await em.nativeDelete(Session, {})
      await em.nativeDelete(User, {})
    },
    async dispose() {
      if (admin) {
        await beforeClose?.(admin.get(DataAccess))
        await admin.close()
      }
      await afterClose?.()
    },
  }
}
