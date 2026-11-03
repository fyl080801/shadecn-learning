import { testConfigModule } from '@learning/config/testing'
import { ConfigService } from '@learning/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStorageOptions } from '../src/options.js'

function resolve(storage: unknown, env: Record<string, string> = {}) {
  const module = testConfigModule({ storage }, { env })
  const provider = module.providers?.[0] as { useValue: ConfigService }
  return resolveStorageOptions(provider.useValue)
}

const KEYS = { PLATFORM_S3_ACCESS_KEY_ID: 'ak', PLATFORM_S3_SECRET_ACCESS_KEY: 'sk' }

describe('storage 配置段', () => {
  afterEach(() => vi.restoreAllMocks())

  it('三样缺一个 = 功能关闭，不拒绝启动，日志写明缺什么', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(resolve(undefined).s3).toBeNull()
    expect(resolve({ bucket: 'b' }).s3).toBeNull()
    expect(resolve({ bucket: 'b' }, { PLATFORM_S3_ACCESS_KEY_ID: 'ak' }).s3).toBeNull()
    expect(resolve({}, KEYS).s3).toBeNull()
    expect(log).toHaveBeenCalledTimes(4)
    expect(log.mock.calls[0][0]).toContain('PLATFORM_S3_ACCESS_KEY_ID')
  })

  it('配齐了：尾部的 / 去掉，默认 region、默认公开地址，内网地址另算', () => {
    expect(resolve({ bucket: 'b', endpoint: 'https://s3.test/' }, KEYS).s3).toEqual({
      endpoint: 'https://s3.test',
      requestEndpoint: '',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    })
    expect(resolve({ bucket: 'b' }, KEYS).s3?.endpoint).toBe('https://s3.fyl080801.uk')
    const internal = resolve({ bucket: 'b', endpoint: 'https://s3.test', internalEndpoint: ' http://minio:9000/ ', region: 'eu' }, KEYS).s3
    expect(internal).toMatchObject({ endpoint: 'https://s3.test', requestEndpoint: 'http://minio:9000', region: 'eu' })
  })

  it('默认值：上限 100MB、键前缀 canvas（去掉首尾斜杠），空串 = 桶根', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(resolve(undefined)).toMatchObject({ maxUploadBytes: 100 * 1024 * 1024, keyPrefix: 'canvas' })
    expect(resolve({ keyPrefix: '/dev/canvas/', maxUploadMb: 5 })).toMatchObject({ maxUploadBytes: 5 * 1024 * 1024, keyPrefix: 'dev/canvas' })
    expect(resolve({ keyPrefix: '' }).keyPrefix).toBe('')
  })

  it('写错的值拒绝启动：不能悄悄用默认值', () => {
    expect(() => resolve({ maxUploadMb: 'abc' })).toThrow('storage.maxUploadMb')
    expect(() => resolve({ maxUploadMb: 0 })).toThrow('storage.maxUploadMb')
    expect(() => resolve({ bucket: 1 })).toThrow('storage.bucket')
    expect(() => resolve('oops')).toThrow('storage 段必须是映射')
  })

  it('密钥写进 config.yaml → 拒绝启动，错误里没有密钥本身', () => {
    expect(() => resolve({ accessKeyId: 'hunter2' })).toThrow('PLATFORM_S3_ACCESS_KEY_ID')
    expect(() => resolve({ secretAccessKey: 'hunter2' })).toThrow('storage.secretAccessKey')
    expect(() => resolve({ secretAccessKey: 'hunter2' })).not.toThrow('hunter2')
  })
})
