import type { NodeLease } from '@learning/agent-core/occupancy'
import { Cluster, createMemoryBackend } from '@learning/cluster'
import { describe, expect, it } from 'vitest'
import { AgentLeases } from '../src/leases.js'
import { AGENT_HOST_OPTIONS, type AgentHostOptions } from '../src/runtime.js'
import { describeOnBothDatabases } from './helpers.js'

/**
 * 节点占用登记表的宿主实现（docs/20 §3.10.8）：共享层的 `SharedMap` 上，比较后写 / 比较后删按编码后的字符串比。
 * 内存后端与 Redis 后端过的是同一套契约（`packages/cluster/test`），这里只测这层包装的语义。从 `apps/server/test/agent/leases.test.ts` 移植。
 */

const lease = (runId: string): NodeLease => ({
  runId,
  agentId: 'main',
  conversationId: `c_${runId}`,
  owner: { id: 'u1', name: '甲', avatarUrl: null },
  instanceId: 'i1',
  since: 1,
})

describe('共享层上的占用登记表', () => {
  it('占用、续期、只删自己的；过期后别人能占，旧持有者续不回', async () => {
    const registry = new AgentLeases(new Cluster('single', createMemoryBackend(), 'i1'), { leaseTtlMs: 40 })
    const a = lease('r_a')
    const b = lease('r_b')
    expect(await registry.claim('f1', 'n1', a)).toBe(true)
    expect(await registry.claim('f1', 'n1', b)).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(a)
    expect(await registry.renew('f1', 'n1', a)).toBe(true)
    expect(await registry.release('f1', 'n1', b)).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(a)
    expect([...(await registry.list('f1')).keys()]).toEqual(['n1'])
    // 前缀不串画布
    expect(await registry.list('f')).toEqual(new Map())

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await registry.get('f1', 'n1')).toBeNull()
    expect(await registry.claim('f1', 'n1', b)).toBe(true)
    expect(await registry.renew('f1', 'n1', a)).toBe(false)
    expect(await registry.release('f1', 'n1', a)).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(b)
    // 转交：比较后写，旧值对不上不写
    expect(await registry.transfer('f1', 'n1', a, lease('r_other'))).toBe(false)
    expect(await registry.get('f1', 'n1')).toEqual(b)
    expect(await registry.transfer('f1', 'n1', b, lease('r_child'))).toBe(true)
    expect((await registry.get('f1', 'n1'))?.runId).toBe('r_child')
    expect(await registry.release('f1', 'n1', lease('r_child'))).toBe(true)
    expect(await registry.list('f1')).toEqual(new Map())
  })

  it('续期把 TTL 往后推，转交也是', async () => {
    const registry = new AgentLeases(new Cluster('single', createMemoryBackend(), 'i1'), { leaseTtlMs: 60 })
    const a = lease('r_a')
    await registry.claim('f1', 'n1', a)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await registry.renew('f1', 'n1', a)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await registry.get('f1', 'n1')).toEqual(a)
    const c = lease('r_c')
    expect(await registry.transfer('f1', 'n1', a, c)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await registry.get('f1', 'n1')).toEqual(c)
  })

  it('形状不对的条目当作不存在（手工改过的、别的版本写坏的）；有这个字段之前写的按入口 agent 读', async () => {
    const backend = createMemoryBackend()
    const registry = new AgentLeases(new Cluster('single', backend, 'i1'), { leaseTtlMs: 1000 })
    const table = backend.createMap<string>('agent-node-lease', { encode: (value) => value, decode: (raw) => raw })
    await table.set('f1:bad', '{"runId":1}')
    await table.set('f1:junk', 'not json')
    const { agentId: _agentId, ...old } = lease('r_old')
    await table.set('f1:old', JSON.stringify(old))
    expect([...(await registry.list('f1')).entries()]).toEqual([['old', { ...old, agentId: 'main' }]])
    expect(await registry.get('f1', 'bad')).toBeNull()
  })
})

describeOnBothDatabases('生产接线', 'agent_leases', (ctx) => {
  it('AGENT_HOST_OPTIONS 带的就是共享层那一份，TTL 取 agent.leaseTtlMs（默认 30 秒）', () => {
    const leases = ctx.app.get(AgentLeases, { strict: false })
    expect(ctx.app.get<AgentHostOptions>(AGENT_HOST_OPTIONS, { strict: false }).leases).toBe(leases)
    expect(leases.ttlMs).toBe(30_000)
    expect(leases.instanceId).toEqual(expect.any(String))
  })
})
