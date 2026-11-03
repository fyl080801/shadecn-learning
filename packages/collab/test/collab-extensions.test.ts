import { describe, expect, it } from 'vitest'
import { createCollabExtensions, redisClientOptions } from '../src/collab-extensions.js'

describe('Hocuspocus 扩展', () => {
  it('没有 Redis 就是空列表：single 模式不加载扩展', async () => {
    expect(await createCollabExtensions({ instanceId: 'a', redisUrl: undefined })).toEqual([])
  })

  it('连接串：默认端口和库，用户名和密码要解码，IPv6 去掉方括号，rediss 开 TLS', () => {
    expect(redisClientOptions('redis://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 6379, options: { username: undefined, password: undefined, db: 0 } })
    expect(redisClientOptions('redis://default:p%40ss%2Fword@redis.internal:6380/2')).toEqual({
      host: 'redis.internal',
      port: 6380,
      options: { username: 'default', password: 'p@ss/word', db: 2 },
    })
    expect(redisClientOptions('rediss://[::1]:6379').host).toBe('::1')
    expect(redisClientOptions('rediss://example.com').options).toMatchObject({ tls: {} })
  })
})
