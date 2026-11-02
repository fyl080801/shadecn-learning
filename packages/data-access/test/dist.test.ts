import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Inject, Injectable, Module } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as ConfigTesting from '@learning/config/testing'
import type * as DataAccessPackage from '../src/index.js'
import { boot } from './helpers.js'

const packageDir = path.resolve(import.meta.dirname, '..')
// 放在本包的 node_modules 下：产物里的 external 要从这里往上解析到本包声明的依赖
const outdir = path.join(packageDir, 'node_modules/.tmp/dist-test')
const configDir = path.resolve(packageDir, '../config')

/**
 * 真实的 esbuild 产物。源码测试过了 swc，swc 会输出 emitDecoratorMetadata，esbuild 不会 ——
 * 包内哪个构造函数参数忘了写 @Inject，只有跑产物才炸；`@shadecn/*` 有没有内联干净也只有产物看得出来。
 * `@learning/config` 同理：它必须留 external。内联了就是第二份 ConfigService，注入 token 对不上，下面的启动用例会失败。
 */
describe('产物 dist/index.js', () => {
  let dist: typeof DataAccessPackage
  let configTesting: typeof ConfigTesting
  let dir: string

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(packageDir, 'scripts/build.mjs'), outdir], { stdio: 'pipe' })

    // 产物 import 的是 @learning/config 的 dist（Node 解析，不走 vitest 的 alias），所以要先有它。
    // 测试入口也得从同一份 dist 加载：这个文件放在 node_modules 下，由 Node 原生执行；写成 vitest 里的 import 拿到的是 alias 到源码的第二份类
    const tsc = createRequire(path.join(configDir, 'package.json')).resolve('typescript/bin/tsc')
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: configDir, stdio: 'pipe' })
    const entry = path.join(outdir, 'config-testing.mjs')
    fs.writeFileSync(entry, `export * from '@learning/config/testing'\n`)
    configTesting = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as typeof ConfigTesting
    dist = (await import(/* @vite-ignore */ pathToFileURL(path.join(outdir, 'index.js')).href)) as typeof DataAccessPackage
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-access-dist-'))
  })

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('运行时不 import @shadecn/*：都内联了', () => {
    const code = fs.readFileSync(path.join(outdir, 'index.js'), 'utf8')
    expect(code).not.toMatch(/(from|import\()\s*["']@shadecn\//)
  })

  it('@learning/config 留 external：进程里只有一份 ConfigService', () => {
    const code = fs.readFileSync(path.join(outdir, 'index.js'), 'utf8')
    expect(code).toMatch(/from\s*["']@learning\/config["']/)
    expect(code).not.toMatch(/ConfigService = class|class ConfigService/)
  })

  it('登录协议层和身份判定经产物转出，session 拿到的是内联的那一份', () => {
    for (const name of ['createOidcClient', 'createGithubClient', 'OidcError', 'randomToken', 'pickOrigin', 'normalizeOrigin', 'resolveLoginIdentity', 'renderLoginDonePage'] as const) {
      expect(dist[name], name).toBeTypeOf('function')
    }
    expect(dist.LOGIN_DONE_PATH).toBe('/auth/login-done')
    expect(dist.renderLoginDonePage()).toContain('app-auth:login-done')
  })

  it('没有装饰器元数据也能注入：启动建表，消费者用产物导出的实体增查', async () => {
    const { DataAccess, DataAccessModule, User } = dist
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    @Injectable()
    class Store {
      constructor(@Inject(DataAccess) readonly dataAccess: DataAccessPackage.DataAccess) {}
    }
    @Module({ providers: [Store] })
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
    await em.flush()
    expect(await app.get(Store).dataAccess.em().count(User)).toBe(1)
    await app.close()
    log.mockRestore()
  })
})
