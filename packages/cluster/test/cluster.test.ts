import 'reflect-metadata'
import fs from 'node:fs'
import path from 'node:path'
import { testConfigModule } from '@learning/config/testing'
import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertClusterDatabase, Cluster, ClusterModule } from '../src/index.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

// ioredis 一加载就报错：证明 single 模式走不到它
let ioredisLoaded = false
vi.mock('ioredis', async (importOriginal) => {
  ioredisLoaded = true
  return importOriginal()
})

@Module({})
class Root {}

const boot = (values: Record<string, unknown>, env: Record<string, string> = {}) =>
  NestFactory.createApplicationContext(
    { module: Root, imports: [testConfigModule(values, { env }), ClusterModule] },
    { logger: false, abortOnError: false },
  )

describe('cluster 配置段', () => {
  afterEach(() => vi.restoreAllMocks())

  it('什么都没写：single，不加载 ioredis', async () => {
    const app = await boot({})
    expect(app.get(Cluster).mode).toBe('single')
    expect(ioredisLoaded).toBe(false)
    await app.close()
  })

  it('mode: single 配了地址：以 mode 为准，不连 Redis', async () => {
    const app = await boot({ cluster: { mode: 'single', url: 'redis://127.0.0.1:1' } })
    expect(app.get(Cluster).mode).toBe('single')
    await app.close()
  })

  it.each([
    ['写了别的 mode', { mode: 'cluster' }, {}, 'cluster.mode 只能是 single 或 redis'],
    ['mode 类型不对', { mode: 1 }, {}, 'cluster.mode 只能是 single 或 redis'],
    ['redis 没有地址', { mode: 'redis' }, {}, 'PLATFORM_REDIS_URL'],
    ['url 类型不对', { url: 1 }, {}, 'cluster.url 必须是字符串'],
    ['协议不对', { url: 'http://x' }, {}, 'redis:// 或 rediss://'],
    ['.env 里的协议不对，错误不带值', {}, { PLATFORM_REDIS_URL: 'http://:hunter2@x' }, 'redis:// 或 rediss://'],
  ])('%s → 拒绝启动', async (_name, cluster, env, message) => {
    const failure = boot({ cluster }, env)
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.not.toThrow('hunter2')
  })

  it('cluster 段不是映射 → 拒绝启动', async () => {
    await expect(boot({ cluster: 'redis' })).rejects.toThrow('cluster 段必须是映射')
  })

  it('有地址、没写 mode：推断成 redis，连不上就拒绝启动；.env 优先于 cluster.url', async () => {
    await expect(boot({ cluster: { url: 'redis://127.0.0.1:1' } })).rejects.toThrow('连不上 Redis')
    await expect(boot({ cluster: { url: 'http://ignored' } }, { PLATFORM_REDIS_URL: 'redis://127.0.0.1:1' })).rejects.toThrow('连不上 Redis')
  })

  it.skipIf(!redisUrl)('redis 模式：mode 是 redis；关闭时 onModuleDestroy 还能用锁，之后连接断开，关两次不出错', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let duringDestroy: string | undefined

    @Injectable()
    class Flusher implements OnModuleDestroy {
      constructor(readonly cluster: Cluster) {}
      async onModuleDestroy() {
        duringDestroy = await this.cluster.createLock('shutdown-test').run('k', () => Promise.resolve('还能用'), {
          fallback: () => Promise.resolve('fallback'),
          ttlMs: 1000,
        })
      }
    }
    @Module({ providers: [Flusher] })
    class FlusherModule {}

    const app = await NestFactory.createApplicationContext(
      { module: Root, imports: [FlusherModule, testConfigModule({}, { env: { PLATFORM_REDIS_URL: redisUrl } }), ClusterModule] },
      { logger: false, abortOnError: false },
    )
    const cluster = app.get(Cluster)
    expect(cluster.mode).toBe('redis')
    await app.close()
    expect(duringDestroy).toBe('还能用')
    await app.close()
    await cluster.onApplicationShutdown()
  })
})

describe('assertClusterDatabase', () => {
  afterEach(() => vi.restoreAllMocks())

  it('生产 + redis + SQLite → 抛错', () => {
    expect(() => assertClusterDatabase({ mode: 'redis', isProduction: true, databaseProvider: 'sqlite' })).toThrow('拒绝启动')
  })

  it('开发 + redis + SQLite → 只警告（单进程验证 Redis 链路是合法用法）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    assertClusterDatabase({ mode: 'redis', isProduction: false, databaseProvider: 'sqlite' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SQLite'))
  })

  it.each([
    ['redis', 'postgresql'],
    ['single', 'sqlite'],
    ['single', 'postgresql'],
  ] as const)('%s + %s → 放行', (mode, databaseProvider) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    assertClusterDatabase({ mode, isProduction: true, databaseProvider })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('包的依赖边界', () => {
  const dir = path.resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))

  it('不依赖业务模块和 @shadecn/*；config 是 peer；ioredis 复用现有的版本范围', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => /^@shadecn\/|^@learning\/(data-access|session|web|foundation)$/.test(name))).toEqual([])
    expect(manifest.peerDependencies['@learning/config']).toBeDefined()
    expect(manifest.dependencies.ioredis).toBe('^5.6.1')
  })

  it('只有 redis.ts 静态 import ioredis，它自己只被动态 import', () => {
    for (const file of fs.readdirSync(path.join(dir, 'src'))) {
      const code = fs.readFileSync(path.join(dir, 'src', file), 'utf8')
      if (file !== 'redis.ts') expect(code, file).not.toMatch(/from 'ioredis'/)
      expect(code, file).not.toMatch(/from '\.\/redis\.js'/)
    }
  })
})
