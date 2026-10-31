import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { ALL_ROLES, resolveModules, startModules, type ServerRole } from '@shadecn/server-kit/kernel'
import { assetStorage, createStorageModule, replaceAssetStorage } from '../src/index.ts'

const roles = new Set<ServerRole>(ALL_ROLES)
const context = { roles, app: {}, server: {} as Server, isDev: false }

const S3 = {
  endpoint: 'https://s3.test',
  region: 'us-east-1',
  bucket: 'canvas',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
}

afterEach(() => replaceAssetStorage(undefined))

describe('createStorageModule：开关跟着宿主交进来的配置走', () => {
  it('没配 S3 → 模块关掉，原因带进能力表；客户端是 null', () => {
    const resolved = resolveModules([createStorageModule({ s3: null, disabledReason: '没配 S3_BUCKET' })], { roles })

    expect(resolved.ordered).toEqual([])
    expect(resolved.skipped).toMatchObject([{ reason: 'disabled', detail: '没配 S3_BUCKET' }])
    expect(assetStorage()).toBeNull()
  })

  it('配了 → 装配后有客户端，收尾后回到 null', async () => {
    const module = createStorageModule({ s3: S3 })
    const loaded = await startModules(resolveModules([module], { roles }).ordered, context)

    expect(assetStorage()?.objectUrl('a/b.png')).toBe('https://s3.test/canvas/a/b.png')

    await loaded.shutdown()
    expect(assetStorage()).toBeNull()
  })

  it('只随 web / agent 角色加载，纯协同实例不带它', () => {
    const resolved = resolveModules([createStorageModule({ s3: S3 })], { roles: new Set<ServerRole>(['collab']) })
    expect(resolved.skipped).toMatchObject([{ reason: 'role' }])
  })
})
