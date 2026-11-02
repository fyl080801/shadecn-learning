import 'reflect-metadata'
import { Cluster, ClusterModule, createMemoryBackend } from '@learning/cluster'
import { testConfigModule } from '@learning/config/testing'
import type { DataAccess } from '@learning/data-access'
import type { INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessRevocation } from '../src/access-revocation.js'
import { CANVAS_FLUSH_CONTENT, FlowDocStore } from '../src/flow-doc.store.js'

/**
 * 跨进程只走共享层（docs/30 §2）：内存实现下两个 `Cluster` 共用一个后端，Redis 下是两条连接。
 * canvas 不认识协同，「另一个实例」这里就是另一个 `Cluster`。
 */
function contract(open: () => Promise<{ web: Cluster; collab: Cluster; close: () => Promise<void> }>) {
  let pair: Awaited<ReturnType<typeof open>>
  // flush 只碰共享层，不碰库
  const storeOn = (cluster: Cluster) => new FlowDocStore({} as DataAccess, cluster)

  afterEach(async () => {
    await pair?.close()
    vi.restoreAllMocks()
  })

  it('撤权：别的实例的观察者看得到，第一次只记不报，本实例的订阅者才被当场通知', async () => {
    pair = await open()
    const web = new AccessRevocation(pair.web)
    const collab = new AccessRevocation(pair.collab)
    const watcher = collab.createWatcher()
    const local = vi.fn()
    const remote = vi.fn()
    web.onRevoked(local)
    collab.onRevoked(remote)

    expect(await watcher.changed()).toBe(false)
    await web.revoke()

    expect(local).toHaveBeenCalledTimes(1)
    expect(remote).not.toHaveBeenCalled()
    expect(await watcher.changed()).toBe(true)
    expect(await watcher.changed()).toBe(false)
  })

  it('落库请求：每个提供方都收到，全部落完才返回', async () => {
    pair = await open()
    const flushed: string[] = []
    const off = await pair.collab.bus.handle(CANVAS_FLUSH_CONTENT, async ({ flowId }) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      flushed.push(`${pair.collab.instanceId}:${flowId}`)
      return null
    })

    await storeOn(pair.web).flush('flow-1')

    expect(flushed).toEqual([`${pair.collab.instanceId}:flow-1`])
    await off()
  })

  it('没有提供方：立刻返回', async () => {
    pair = await open()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = Date.now()
    await storeOn(pair.web).flush('flow-2')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('提供方落库失败：不抛错，记一笔', async () => {
    pair = await open()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const off = await pair.collab.bus.handle(CANVAS_FLUSH_CONTENT, () => {
      throw new Error('写库失败')
    })

    await expect(storeOn(pair.web).flush('flow-3')).resolves.toBeUndefined()

    expect(warn.mock.calls.flat().join(' ')).toContain('写库失败')
    await off()
  })
}

describe('跨实例（内存）', () => {
  contract(async () => {
    const backend = createMemoryBackend()
    const shared = { ...backend, close: () => Promise.resolve() }
    const web = new Cluster('single', shared, 'web')
    const collab = new Cluster('single', shared, 'collab')
    return {
      web,
      collab,
      close: async () => {
        await web.onApplicationShutdown()
        await collab.onApplicationShutdown()
        await backend.close()
      },
    }
  })

  it('共享层写失败、读失败：撤权都不抛错，接口不受影响', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = {
      createMap: () => ({
        set: () => Promise.reject(new Error('Redis 挂了')),
        get: () => Promise.reject(new Error('Redis 挂了')),
      }),
    } as unknown as Cluster
    const revocation = new AccessRevocation(broken)
    const listener = vi.fn()
    revocation.onRevoked(listener)

    await expect(revocation.revoke()).resolves.toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(revocation.createWatcher().changed()).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL

describe.skipIf(!redisUrl)('跨实例（Redis，PLATFORM_TEST_REDIS_URL）', () => {
  contract(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const boot = (): Promise<INestApplicationContext> =>
      NestFactory.createApplicationContext(
        { module: class RedisRoot {}, imports: [testConfigModule({ cluster: { mode: 'redis', url: redisUrl } }), ClusterModule] },
        { logger: false, abortOnError: false },
      )
    const [webContext, collabContext] = await Promise.all([boot(), boot()])
    return {
      web: webContext.get(Cluster, { strict: false }),
      collab: collabContext.get(Cluster, { strict: false }),
      close: async () => {
        await webContext.close()
        await collabContext.close()
      },
    }
  })
})
