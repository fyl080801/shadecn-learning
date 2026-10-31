import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus, useBusForTesting, type Bus } from '@shadecn/server-kit/bus'
import { createMemoryBackend } from '@shadecn/server-kit/cluster/memory'
import { jsonCodec, stringCodec, type ClusterBackend, type SharedMap } from '@shadecn/server-kit/cluster'
import { COLLAB_FLUSH_ROOM, flushRoom } from '../src/contract.ts'

/**
 * `flushRoom`：别的角色（复制画布的 web 路由）经总线让所有协同实例落库。
 * 它**从不抛错**：调用方读到的最差是上一次落库的内容，和房间开在别的副本上时一样。
 */

/**
 * 内存后端的 `createMap` 每次都是一张新表（只有 log 和频道按命名空间共享），所以模拟多个实例时
 * 登记表要按后端共用一张 —— 对应 Redis 下大家读写同一个键空间
 */
const registries = new WeakMap<ClusterBackend, SharedMap<string>>()
function respondersOf(backend: ClusterBackend): SharedMap<string> {
  let map = registries.get(backend)
  if (!map) registries.set(backend, (map = backend.createMap('bus-responder', stringCodec)))
  return map
}

const buses: Bus[] = []
const restores: (() => void)[] = []

function instance(backend: ClusterBackend, id: string): Bus {
  const bus = createBus({
    instanceId: id,
    channel: backend.createChannel('bus', jsonCodec()),
    responders: respondersOf(backend),
  })
  buses.push(bus)
  return bus
}

afterEach(async () => {
  for (const restore of restores.splice(0)) restore()
  for (const bus of buses.splice(0)) await bus.close()
  vi.restoreAllMocks()
})

describe('flushRoom', () => {
  it('每个协同实例都收到同一张画布的落库请求，全部落完才返回', async () => {
    const backend = createMemoryBackend()
    const web = instance(backend, 'web')
    const flushed: string[] = []
    for (const id of ['collab-1', 'collab-2']) {
      await instance(backend, id).handle(COLLAB_FLUSH_ROOM, async ({ flowId }) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        flushed.push(`${id}:${flowId}`)
        return null
      })
    }
    restores.push(useBusForTesting(web))

    await flushRoom('flow-1')

    expect(flushed.sort()).toEqual(['collab-1:flow-1', 'collab-2:flow-1'])
  })

  it('没有协同实例（协同模块没开）→ 立刻返回，不报错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    restores.push(useBusForTesting(instance(createMemoryBackend(), 'web')))

    await expect(flushRoom('flow-1')).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('某个协同实例落库失败 → 记一笔然后照常返回', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const backend = createMemoryBackend()
    const web = instance(backend, 'web')
    await instance(backend, 'collab-1').handle(COLLAB_FLUSH_ROOM, () => {
      throw new Error('数据库连不上')
    })
    restores.push(useBusForTesting(web))

    await expect(flushRoom('flow-1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collab-1: 数据库连不上'))
  })
})
