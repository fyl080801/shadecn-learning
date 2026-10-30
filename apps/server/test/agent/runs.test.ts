import { describe, expect, it } from 'vitest'
import type { RunRecord, StopCommand } from '@shadecn/agent/run-registry'
import { agentHostOptions } from '../../agent/index.ts'
import { agentRunRegistry, createSharedRunRegistry } from '../../agent/runs.ts'
import { stringCodec } from '../../cluster/index.ts'
import { createMemoryBackend } from '../../cluster/memory.ts'
import { agentConfig, instanceId } from '../../config.ts'

/**
 * 运行中轮次共享登记的宿主实现（docs/20 §3.10.10）：共享层的 `SharedMap` / `SharedLog` / `SharedChannel` 上的一层包装。
 * 三个原语的内存 / Redis 契约在 `test/cluster/shared.test.ts`，双副本的端到端在 `multi-replica.test.ts`；这里只测包装的语义。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function registries(ttlMs = 60) {
  const backend = createMemoryBackend()
  const tables = {
    runs: backend.createMap<string>('t-run', stringCodec),
    slots: backend.createMap<string>('t-slot', stringCodec),
    replay: backend.createLog<string>('t-replay', stringCodec),
    stops: backend.createChannel<string>('t-stop', stringCodec),
  }
  return {
    a: createSharedRunRegistry(tables, { ttlMs, instanceId: 'A' }),
    b: createSharedRunRegistry(tables, { ttlMs, instanceId: 'B' }),
    tables,
  }
}

const record = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  runId,
  conversationId: `c_${runId}`,
  conversationTitle: '标题',
  owner: { id: 'u1', name: '甲', avatarUrl: null },
  startedAt: 1,
  occupies: [],
  expiresAt: 100,
  instanceId: 'A',
  ...extra,
})

describe('共享层上的运行登记', () => {
  it('接线：宿主给编排层的就是这一份，TTL 取 AGENT_LEASE_TTL_MS，副本标识取 INSTANCE_ID', () => {
    expect(agentHostOptions.runRegistry).toBe(agentRunRegistry)
    expect(agentRunRegistry.ttlMs).toBe(agentConfig.leaseTtlMs)
    expect(agentRunRegistry.instanceId).toBe(instanceId)
  })

  it('任务登记：覆盖写、按画布前缀列出、只删值相同的；TTL 到点消失', async () => {
    const { a, b } = registries()
    const first = record('r1')
    await a.putRun('f1', first)
    await a.putRun('f2', record('r2'))
    expect(await b.listRuns('f1')).toEqual([first])
    const moved = record('r1', { occupies: ['n1'], expiresAt: 200 })
    await a.putRun('f1', moved)
    expect(await b.getRun('f1', 'r1')).toEqual(moved)
    // 旧值删不掉（比较后删）
    expect(await a.releaseRun('f1', first)).toBe(false)
    expect(await a.releaseRun('f1', moved)).toBe(true)
    expect(await b.getRun('f1', 'r1')).toBeNull()
    expect(await b.getRun('f2', 'r2')).not.toBeNull()
    await sleep(80)
    expect(await b.listRuns('f2')).toEqual([])
  })

  it('形状不对的登记 / 槽位当作不存在（别的版本写坏的、手工改过的）', async () => {
    const { a, tables } = registries()
    await tables.runs.set('f1:bad', '{"runId":1}')
    await tables.runs.set('f1:junk', 'not json')
    await tables.slots.set('f1:c1', '{}')
    expect(await a.listRuns('f1')).toEqual([])
    expect(await a.getSlot('f1', 'c1')).toBeNull()
  })

  it('会话槽位：先到先得；续期 / 释放只对自己的值生效；过期后别人能占、旧持有者续不回', async () => {
    const { a, b } = registries(50)
    const mine = { runId: 'r1', instanceId: 'A' }
    const theirs = { runId: 'r2', instanceId: 'B' }
    expect(await a.claimSlot('f1', 'c1', mine)).toBe(true)
    expect(await b.claimSlot('f1', 'c1', theirs)).toBe(false)
    expect(await b.busyConversations('f1')).toEqual(new Set(['c1']))
    expect(await b.renewSlot('f1', 'c1', theirs)).toBe(false)
    expect(await b.releaseSlot('f1', 'c1', theirs)).toBe(false)
    expect(await a.renewSlot('f1', 'c1', mine)).toBe(true)
    await sleep(70)
    expect(await b.getSlot('f1', 'c1')).toBeNull()
    expect(await b.claimSlot('f1', 'c1', theirs)).toBe(true)
    expect(await a.renewSlot('f1', 'c1', mine)).toBe(false)
    expect(await a.releaseSlot('f1', 'c1', mine)).toBe(false)
    expect(await b.getSlot('f1', 'c1')).toEqual(theirs)
  })

  it('补发日志：按顺序追加、从游标接着读、阻塞等新的；每次追加续一个 TTL，不续就过期', async () => {
    const { a, b } = registries(80)
    await a.appendReplay('r1', { seq: 1, events: [] }, 100)
    const [first] = await b.readReplay('r1', null)
    expect(first!.record).toEqual({ seq: 1, events: [] })
    const waiting = b.waitReplay('r1', first!.cursor, 1000)
    await sleep(20)
    await a.appendReplay('r1', { seq: 2, events: [], overflow: true }, 100)
    expect((await waiting).map((entry) => entry.record)).toEqual([{ seq: 2, events: [], overflow: true }])
    await sleep(50)
    await a.keepReplay('r1')
    await sleep(50)
    expect(await b.readReplay('r1', null)).toHaveLength(2)
    await sleep(60)
    expect(await b.readReplay('r1', null)).toEqual([])
  })

  it('停止指令只送到登记里的那个副本', async () => {
    const { a, b } = registries()
    const toA: StopCommand[] = []
    const toB: StopCommand[] = []
    const offA = await a.onStop((command) => toA.push(command))
    const offB = await b.onStop((command) => toB.push(command))
    await b.sendStop('A', { flowId: 'f1', runId: 'r1', reason: '已中止' })
    await sleep(20)
    expect(toA).toEqual([{ flowId: 'f1', runId: 'r1', reason: '已中止' }])
    expect(toB).toEqual([])
    await offA()
    await offB()
  })
})
