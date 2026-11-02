import 'reflect-metadata'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ConfigModule, ConfigService } from '@learning/config'
import { testConfigModule } from '@learning/config/testing'
import { type CanActivate, Controller, Get, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapService, serverHost, serverPort } from '../src/index.js'

let shutdowns = 0

@Injectable()
class Closer implements OnApplicationShutdown {
  onApplicationShutdown() {
    shutdowns += 1
  }
}

/** 全局拒绝一切的守卫：模拟 `ApiSessionGuard` 这类默认拦住 /api 的情况 */
@Injectable()
class DenyAll implements CanActivate {
  canActivate() {
    return false
  }
}

@Controller('api')
class ProbeController {
  @Get('guarded')
  guarded() {
    return { ok: true }
  }
}

const SILENT = { nest: { logger: false as const, abortOnError: false } }

/** 走真实的 config.yaml：`bootstrapService` 用的是 ConfigModule 读到的那份 ConfigService */
function rootWith(server: unknown) {
  @Module({
    imports: [testConfigModule({ server })],
    controllers: [ProbeController],
    providers: [Closer, { provide: APP_GUARD, useClass: DenyAll }],
  })
  class Root {}
  return Root
}

describe('bootstrapService', () => {
  let app: NestFastifyApplication | undefined
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    shutdowns = 0
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('按 server.port 监听，打一条带服务名的启动日志', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo
        probe.close(() => resolve(port))
      })
    })
    app = await bootstrapService(rootWith({ port: free }), { name: 'probe', ...SILENT })
    expect(await app.getUrl()).toContain(`:${free}`)
    expect(log).toHaveBeenCalledWith(`[probe] 已启动：${await app.getUrl()}`)
  })

  it('/api/health 匿名 200，全局守卫挡不住；同前缀下的 Nest 路由照样被挡', async () => {
    app = await bootstrapService(rootWith({ port: 0 }), { name: 'probe', ...SILENT })
    const url = await app.getUrl()

    const health = await fetch(`${url}/api/health`)
    expect(health.status).toBe(200)
    expect(health.headers.get('content-type')).toContain('application/json')
    const body = (await health.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.uptime).toBeTypeOf('number')
    expect(new Date(body.timestamp as string).toISOString()).toBe(body.timestamp)

    expect((await fetch(`${url}/api/guarded`)).status).toBe(403)
  })

  it('业务模块也声明了 /api/health → 启动失败（Fastify 重复路由），不会悄悄被其中一个盖掉', async () => {
    @Controller('api')
    class Duplicate {
      @Get('health')
      health() {
        return 'mine'
      }
    }
    @Module({ imports: [testConfigModule({ server: { port: 0 } })], controllers: [Duplicate] })
    class Root {}
    await expect(bootstrapService(Root, { name: 'probe', ...SILENT })).rejects.toThrow(/\/api\/health/)
  })

  it('开了关闭钩子：SIGTERM 的监听器在，close 走完关闭流程', async () => {
    const before = process.listenerCount('SIGTERM')
    app = await bootstrapService(rootWith({ port: 0 }), { name: 'probe', ...SILENT })
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await app.close()
    app = undefined
    expect(shutdowns).toBe(1)
  })

  it('server.host 写了就听它：只听 127.0.0.1 时 IPv6 回环连不上；0.0.0.0 监听所有 IPv4 地址', async () => {
    app = await bootstrapService(rootWith({ port: 0, host: '127.0.0.1' }), { name: 'probe', ...SILENT })
    const { port } = new URL(await app.getUrl())
    expect((app.getHttpServer().address() as net.AddressInfo).address).toBe('127.0.0.1')
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    await app.close()

    app = await bootstrapService(rootWith({ port: 0, host: '0.0.0.0' }), { name: 'probe', ...SILENT })
    expect((app.getHttpServer().address() as net.AddressInfo).address).toBe('0.0.0.0')
  })

  it('server.host 不写：保持默认，只听本机', async () => {
    app = await bootstrapService(rootWith({ port: 0 }), { name: 'probe', ...SILENT })
    expect(['127.0.0.1', '::1']).toContain((app.getHttpServer().address() as net.AddressInfo).address)
  })

  it('server.host 不合法 → 把错误交给调用方，已建好的模块先关掉', async () => {
    await expect(bootstrapService(rootWith({ port: 0, host: 80 }), { name: 'probe', ...SILENT })).rejects.toThrow('server.host')
    expect(shutdowns).toBe(1)
  })

  it('端口不合法 → 把错误交给调用方，已建好的模块先关掉', async () => {
    await expect(bootstrapService(rootWith({ port: 'abc' }), { name: 'probe', ...SILENT })).rejects.toThrow('server.port')
    expect(shutdowns).toBe(1)
  })

  it('端口被占用 → 把错误交给调用方，已建好的模块先关掉', async () => {
    // 用另一个服务占端口：默认监听 localhost，解析成哪个地址因机器而异，这样两边绑的地址一定相同
    app = await bootstrapService(rootWith({ port: 0 }), { name: 'holder', ...SILENT })
    const port = Number(new URL(await app.getUrl()).port)
    shutdowns = 0
    await expect(bootstrapService(rootWith({ port }), { name: 'probe', ...SILENT })).rejects.toThrow(/EADDRINUSE/)
    expect(shutdowns).toBe(1)
  })

  it('端口读的是 ConfigModule 的 config.yaml', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'server:\n  port: 0\n')
    vi.stubEnv('DATA_DIR', dir)
    @Module({ imports: [ConfigModule] })
    class Root {}
    try {
      app = await bootstrapService(Root, { name: 'probe', ...SILENT })
      expect(app.get(ConfigService).dataDir).toBe(dir)
      expect((await fetch(`${await app.getUrl()}/api/health`)).status).toBe(200)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('serverPort', () => {
  const portOf = (server: unknown) =>
    serverPort(new ConfigService({ rootDir: '/', dataDir: '/data', isProduction: false, values: { server } }))

  it('默认 3001：3000 是 apps/server 的', () => {
    expect(portOf(undefined)).toBe(3001)
    expect(portOf({})).toBe(3001)
  })

  it('配了就用；0 是系统分配，合法', () => {
    expect(portOf({ port: 4000 })).toBe(4000)
    expect(portOf({ port: 0 })).toBe(0)
  })

  it.each(['3001', 3.5, -1, 65536])('不合法（%j）→ 抛错', (port) => {
    expect(() => portOf({ port })).toThrow('server.port')
  })
})

describe('serverHost', () => {
  const hostOf = (server: unknown) =>
    serverHost(new ConfigService({ rootDir: '/', dataDir: '/data', isProduction: false, values: { server } }))

  it('不写是 undefined；写了就用（去掉前后空白）', () => {
    expect(hostOf(undefined)).toBeUndefined()
    expect(hostOf({})).toBeUndefined()
    expect(hostOf({ host: null })).toBeUndefined()
    expect(hostOf({ host: '0.0.0.0' })).toBe('0.0.0.0')
    expect(hostOf({ host: ' ::1 ' })).toBe('::1')
  })

  it.each(['', '   ', 80, true, []])('不合法（%j）→ 抛错', (host) => {
    expect(() => hostOf({ host })).toThrow('server.host')
  })
})

describe('包的依赖边界', () => {
  it('不依赖 @shadecn/* 和 @learning/session', () => {
    const dir = path.resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/') || name === '@learning/session')).toEqual([])
    expect(manifest.peerDependencies['@learning/config']).toBeDefined()
  })
})
