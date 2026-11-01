import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { MiddlewareHandler } from 'hono'
import { CANVAS_SERVICE, type CanvasService } from '@shadecn/mod-canvas/contract'
import {
  ALL_ROLES,
  defineModule,
  parseModuleConfigs,
  resolveModules,
  startModules,
  type ServerRole,
} from '@shadecn/server-kit/kernel'
import type { Platform, RuntimeInfo } from '@shadecn/server-kit/platform'
import storage, { assetStorage, replaceAssetStorage } from '../src/index.ts'

const roles = new Set<ServerRole>(ALL_ROLES)
const runtime = {} as RuntimeInfo

const S3_ENV = {
  S3_ENDPOINT: 'https://s3.test/',
  S3_BUCKET: 'canvas',
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk',
}

/** 存储硬依赖画布：给一个只提供 `canvas` 服务的假模块 */
const fakeCanvas = defineModule({
  name: 'canvas',
  roles: [...ALL_ROLES],
  provides: [CANVAS_SERVICE],
  setup(ctx) {
    const pass: MiddlewareHandler = (_c, next) => next()
    ctx.provide(CANVAS_SERVICE, { flowGuard: pass, request: {} } as unknown as CanvasService)
  },
})

function configsOf(env: Record<string, string>) {
  return parseModuleConfigs([storage], { get: (name) => env[name] }, runtime)
}

async function boot(env: Record<string, string>) {
  const configs = configsOf(env)
  const resolved = resolveModules([fakeCanvas, storage], { roles, configs: configs.values })
  const mounted: string[] = []
  const loaded = await startModules(resolved.ordered, {
    roles,
    isDev: false,
    platform: {} as Platform,
    server: {} as Server,
    http: { route: (path) => void mounted.push(path), use() {}, upgrade() {} },
    configs: configs.values,
  })
  return { resolved, loaded, mounted }
}

afterEach(() => replaceAssetStorage(undefined))

describe('存储模块：开关跟着自己的配置段走', () => {
  it('没配 S3 → 模块关掉，原因带进能力表；客户端是 null', () => {
    const resolved = resolveModules([fakeCanvas, storage], { roles, configs: configsOf({}).values })
    expect(resolved.skipped).toMatchObject([{ reason: 'disabled', detail: expect.stringContaining('S3_BUCKET') }])
    expect(assetStorage()).toBeNull()
  })

  it('配了 → 装配后有客户端、挂上传接口；收尾后回到 null', async () => {
    const { loaded, mounted } = await boot(S3_ENV)

    // 尾部的 / 被去掉，默认 region / 键前缀
    expect(assetStorage()?.objectUrl('a/b.png')).toBe('https://s3.test/canvas/a/b.png')
    expect(mounted).toEqual(['/api/flows/:flowId/assets'])

    await loaded.shutdown()
    expect(assetStorage()).toBeNull()
  })

  it('配置段的默认值：上限 100MB、键前缀 canvas（去掉首尾斜杠）', () => {
    expect(configsOf(S3_ENV).values.get('storage')).toMatchObject({ maxUploadBytes: 100 * 1024 * 1024, keyPrefix: 'canvas' })
    expect(configsOf({ ...S3_ENV, S3_KEY_PREFIX: '/dev/canvas/' }).values.get('storage')).toMatchObject({ keyPrefix: 'dev/canvas' })
    expect(() => configsOf({ S3_MAX_UPLOAD_MB: 'abc' })).toThrow('S3_MAX_UPLOAD_MB')
  })

  it('只随 web / agent 角色加载，纯协同实例不带它', () => {
    const resolved = resolveModules([storage], { roles: new Set<ServerRole>(['collab']), configs: configsOf(S3_ENV).values })
    expect(resolved.skipped).toMatchObject([{ reason: 'role' }])
  })
})
