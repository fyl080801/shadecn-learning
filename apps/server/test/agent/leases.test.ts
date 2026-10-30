import { describe, expect, it } from 'vitest'
import type { NodeLease } from '@shadecn/agent/occupancy'
import { createSharedLeaseRegistry } from '../../agent/leases.ts'
import { agentHostOptions } from '../../agent/index.ts'
import { agentNodeLeases } from '../../agent/leases.ts'
import { stringCodec } from '../../cluster/index.ts'
import { createMemoryBackend } from '../../cluster/memory.ts'

/**
 * 节点占用登记表的宿主实现（docs/20 §3.10.8）：共享层的 `SharedMap` 上，比较后写 / 比较后删按编码后的字符串比。
 * 内存后端与 redis 后端过的是同一套契约（`test/cluster/shared.test.ts`），这里只测这层包装的语义。
 */

const lease = (runId: string): NodeLease => ({
  runId,
  conversationId: `c_${runId}`,
  owner: { id: 'u1', name: '甲', avatarUrl: null },
  instanceId: 'i1',
  since: 1,
})

describe('共享层上的占用登记表', () => {
  it('占用、续期、只删自己的；过期后别人能占，旧持有者续不回', async () => {
    const backend = createMemoryBackend()
    const registry = createSharedLeaseRegistry(backend.createMap<string>('t-lease', stringCodec), { ttlMs: 40, instanceId: 'i1' })
    const a = lease('r_a')
    const b = lease('r_b')
    expect(await registry.claim('f1', 'n1', a)).toBe(true)
    expect(await registry.claim('f1', 'n1', b)).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(a)
    expect(await registry.renew('f1', 'n1', a)).toBe(true)
    expect(await registry.release('f1', 'n1', b)).toBe(false)
    expect([...(await registry.list('f1')).keys()]).toEqual(['n1'])
    // 前缀不串画布
    expect(await registry.list('f')).toEqual(new Map())

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await registry.get('f1', 'n1')).toBeNull()
    expect(await registry.claim('f1', 'n1', b)).toBe(true)
    expect(await registry.renew('f1', 'n1', a)).toBe(false)
    expect(await registry.release('f1', 'n1', a)).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(b)
    // 转交（预留）：比较后写
    expect(await registry.transfer('f1', 'n1', b, lease('r_child'))).toBe(true)
    expect((await registry.get('f1', 'n1'))?.runId).toBe('r_child')
    expect(await registry.release('f1', 'n1', lease('r_child'))).toBe(true)
    expect(await registry.list('f1')).toEqual(new Map())
  })

  it('生产接线：agentHostOptions 带的就是共享层那一份，TTL 取 AGENT_LEASE_TTL_MS（默认 30 秒）', () => {
    expect(agentHostOptions.leases).toBe(agentNodeLeases)
    expect(agentNodeLeases.ttlMs).toBe(30_000)
    expect(agentNodeLeases.instanceId).toEqual(expect.any(String))
  })
})
