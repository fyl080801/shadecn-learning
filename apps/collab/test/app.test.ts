import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PATH_METADATA } from '@nestjs/common/constants.js'
import { Cluster, ClusterModule } from '@learning/cluster'
import { CollabGatewayModule } from '@learning/collab'
import { ConfigModule } from '@learning/config'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { ClusterDatabaseCheckModule, SessionIdentityModule } from '@learning/session'
import { bootstrapService } from '@learning/foundation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCollabPath } from '../scripts/front-proxy.mjs'
import { AppModule } from '../src/app.module.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

function writeConfig(dataDir: string, values: Record<string, unknown>) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATA_DIR', dataDir)
  vi.stubEnv('PLATFORM_SESSION_SECRET', 'test-secret')
  vi.stubEnv('PLATFORM_DATABASE_URL', '')
  vi.stubEnv('PLATFORM_REDIS_URL', '')
  // JSON 就是合法的 YAML
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), JSON.stringify(values))
}

/** 真实的启动路径，和 main.ts 只差端口和日志 */
const listen = () => bootstrapService(AppModule, { name: 'collab', nest: { logger: false, abortOnError: false } })
const server = { port: 0, host: '127.0.0.1' }

describe('根模块', () => {
  it('imports 就是 docs/30 §3 列的那些：没有页面、登录流程和画布 REST', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toEqual([ConfigModule, DataAccessModule, ClusterModule, SessionIdentityModule, CollabGatewayModule, ClusterDatabaseCheckModule])
  })

  it('前置代理分给副本的路径，覆盖 CollabGatewayModule 的全部控制器和 WebSocket', () => {
    const controllers = Reflect.getMetadata('controllers', CollabGatewayModule) as (new () => object)[]
    const routes = controllers.flatMap((controller) => {
      const base = String(Reflect.getMetadata(PATH_METADATA, controller))
      return Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => Reflect.getMetadata(PATH_METADATA, (controller.prototype as Record<string, object>)[name]) as string | undefined)
        .filter((route) => route !== undefined)
        .map((route) => `/${base}/${route}`.replace(/:\w+/, 'some-flow').replace(/\/+$/, ''))
    })
    expect(routes).toEqual(expect.arrayContaining(['/api/collab/rooms', '/api/collab/health', '/api/flows/some-flow/doc']))
    expect(routes.filter((route) => !isCollabPath(route))).toEqual([])
    expect(isCollabPath('/ws/collaboration')).toBe(true)
  })

  it('画布 REST、登录、页面、Vite 的 WebSocket 都不分给副本', () => {
    for (const pathname of ['/', '/login', '/api/flows/f1', '/api/flows/f1/duplicate', '/api/flows/f1/document', '/api/projects', '/api/auth/me', '/api/auth/identities', '/api/auth/link/github', '/api/avatars/0f4c717d8a4e2a3e.svg', '/api/health/ready', '/assets/a.js', '/@vite/client', '/api/collaboration']) {
      expect(isCollabPath(pathname), pathname).toBe(false)
    }
  })
})

describe('启动', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-service-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('cluster 是 single → 拒绝启动：副本不能各自在内存里持有文档', async () => {
    writeConfig(dir, { server, database: { url: `file:${path.join(dir, 'x.db')}`, schemaSync: 'off' } })
    await expect(listen()).rejects.toThrow('cluster.mode 必须是 redis')
  })

  // 开发环境：生产环境 redis + SQLite 会先被另一条挡下
  it.skipIf(!redisUrl)('schemaSync 不是 off → 拒绝启动：表结构归平台', async () => {
    writeConfig(dir, { server, database: { url: `file:${path.join(dir, 'x.db')}` }, cluster: { mode: 'redis', url: redisUrl } })
    vi.stubEnv('NODE_ENV', 'test')
    await expect(listen()).rejects.toThrow('database.schemaSync 必须写 off')
  })

  it.skipIf(!redisUrl)('生产环境 redis + SQLite → 拒绝启动', async () => {
    writeConfig(dir, { server, database: { url: `file:${path.join(dir, 'x.db')}`, schemaSync: 'off' }, cluster: { mode: 'redis', url: redisUrl } })
    await expect(listen()).rejects.toThrow('生产环境拒绝启动')
  })

  it.skipIf(!redisUrl)('配对了：探针公开，协同接口要登录，画布 REST 和页面都不在这里，不跑 DDL', async () => {
    writeConfig(dir, { server, database: { url: `file:${path.join(dir, 'x.db')}`, schemaSync: 'off' }, cluster: { mode: 'redis', url: redisUrl } })
    vi.stubEnv('NODE_ENV', 'test')
    const app = await listen()
    const status = async (url: string) => (await app.inject({ method: 'GET', url })).statusCode

    expect(await status('/api/health')).toBe(200)
    expect(await status('/api/collab/rooms')).toBe(401)
    expect(await status('/api/projects')).toBe(404)
    expect(await status('/')).toBe(404)
    // 账号关联和头像归平台（LoginModule），副本上没有这些路由；头像靠 User.avatarUrl 过桥（packages/collab/test/avatar.test.ts）
    expect(await status('/api/avatars/0f4c717d8a4e2a3e.svg')).toBe(404)
    expect(await status('/api/auth/identities')).toBe(404)
    expect(app.get(Cluster).mode).toBe('redis')
    const tables = await app.get(DataAccess).em().getConnection().execute<{ name: string }[]>(`select name from sqlite_master where type = 'table'`)
    expect(tables).toEqual([])
    await app.close()
  }, 20_000)
})
