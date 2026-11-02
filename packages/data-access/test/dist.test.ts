import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineEntity, p } from '@mikro-orm/core'
import { Inject, Injectable, Module } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as ConfigTesting from '@learning/config/testing'
import type * as DataAccessPackage from '../src/index.js'
import { boot } from './helpers.js'

const packageDir = path.resolve(import.meta.dirname, '..')
// 放在本包的 node_modules 下：产物里的 external 要从这里往上解析到本包声明的依赖
const outdir = path.join(packageDir, 'node_modules/.tmp/dist-test')
const configDir = path.resolve(packageDir, '../config')
const tsc = createRequire(path.join(packageDir, 'package.json')).resolve('typescript/bin/tsc')

/**
 * 真实的 tsc 产物，由 Node 原生加载。源码测试走的是 vitest 的 alias 和 swc，看不出来 ESM 解析、声明文件能不能输出、
 * 实体和 `ConfigService` 是不是单例这些问题。这个文件放在 node_modules 下，由 Node 原生执行。
 */
describe('产物 dist/index.js', () => {
  let dist: typeof DataAccessPackage
  let configTesting: typeof ConfigTesting
  let dir: string

  beforeAll(async () => {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', outdir], { cwd: packageDir, stdio: 'pipe' })

    // 产物 import 的是 @learning/config 的 dist（Node 解析，不走 vitest 的 alias），所以要先有它。
    // 测试入口也得从同一份 dist 加载：写成 vitest 里的 import 拿到的是 alias 到源码的第二份类
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: configDir, stdio: 'pipe' })
    const entry = path.join(outdir, 'config-testing.mjs')
    fs.writeFileSync(entry, `export * from '@learning/config/testing'\n`)
    configTesting = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as typeof ConfigTesting
    dist = (await import(/* @vite-ignore */ pathToFileURL(path.join(outdir, 'index.js')).href)) as typeof DataAccessPackage
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-access-dist-'))
  }, 120_000)

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('运行时只 import 声明过的包：不内联 @learning/config，也不碰 @shadecn/*', () => {
    const code = fs.readFileSync(path.join(outdir, 'module.js'), 'utf8')
    expect(code).toMatch(/from\s*["']@learning\/config["']/)
    expect(code).not.toMatch(/class ConfigService/)
    for (const file of fs.readdirSync(outdir)) {
      if (file.endsWith('.js')) expect(fs.readFileSync(path.join(outdir, file), 'utf8'), file).not.toContain('@shadecn/')
    }
  })

  it('产出声明文件：消费者拿得到 User 和 DataAccess 的类型', () => {
    const declarations = fs.readFileSync(path.join(outdir, 'index.d.ts'), 'utf8')
    expect(declarations).toContain('User')
    expect(declarations).toContain('DataAccess')
    expect(fs.existsSync(path.join(outdir, 'entities.d.ts'))).toBe(true)
  })

  it('启动建表，模块登记的实体收得到，消费者用产物导出的实体增查', async () => {
    const { DATA_ACCESS_ENTITIES, DataAccess, DataAccessModule, User } = dist
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const Probe = defineEntity({ name: 'DistProbe', properties: { id: p.text().primary() } })

    @Injectable()
    class Store {
      constructor(@Inject(DataAccess) readonly dataAccess: DataAccessPackage.DataAccess) {}
    }
    @Module({ providers: [Store, { provide: DATA_ACCESS_ENTITIES, useValue: [Probe] }] })
    class StoreModule {}

    const config = configTesting.testConfigModule({ database: { url: `file:${path.join(dir, 'dist.db')}` } })
    const app = await boot([StoreModule, config, DataAccessModule])
    const em = app.get(Store).dataAccess.em()
    em.create(User, {
      issuer: 'https://issuer.test',
      subject: 'alice',
      username: null,
      email: null,
      name: null,
      avatarUrl: null,
      roles: '[]',
      lastLoginAt: null,
    })
    em.create(Probe, { id: 'row' })
    await em.flush()
    expect(await app.get(Store).dataAccess.em().count(User)).toBe(1)
    expect(await app.get(Store).dataAccess.em().count(Probe)).toBe(1)
    await app.close()
    log.mockRestore()
  })
})
