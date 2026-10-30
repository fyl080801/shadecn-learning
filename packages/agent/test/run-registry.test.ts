import { describe, expect, it } from 'vitest'
import { createMemoryRunHub, createMemoryRunRegistry, type RunRecord, type StopCommand } from '../src/run-registry.ts'

/**
 * 本包测试用的内存登记（`createMemoryRunRegistry`）：语义要和宿主的共享层实现一致（`apps/server/test/agent/runs.test.ts`），
 * 同一个 hub 上的多个实例 = 多个副本。
 */

const record = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  runId,
  conversationId: `c_${runId}`,
  conversationTitle: '',
  owner: { id: 'u1', name: '甲', avatarUrl: null },
  startedAt: 1,
  occupies: [],
  instanceId: 'A',
  ...extra,
})

describe('内存运行登记', () => {
  it('同一个 hub 上的两个副本看到同一份登记 / 槽位；TTL 按注入的时钟过期', async () => {
    let now = 0
    const hub = createMemoryRunHub()
    const a = createMemoryRunRegistry({ hub, instanceId: 'A', ttlMs: 100, now: () => now })
    const b = createMemoryRunRegistry({ hub, instanceId: 'B', ttlMs: 100, now: () => now })
    await a.putRun('f1', record('r1'))
    expect((await b.listRuns('f1')).map((run) => run.runId)).toEqual(['r1'])
    expect(await a.claimSlot('f1', 'c1', { runId: 'r1', instanceId: 'A' })).toBe(true)
    expect(await b.claimSlot('f1', 'c1', { runId: 'r2', instanceId: 'B' })).toBe(false)
    expect(await b.releaseRun('f1', record('r1', { occupies: ['x'] }))).toBe(false)
    now = 150
    expect(await b.listRuns('f1')).toEqual([])
    expect(await b.claimSlot('f1', 'c1', { runId: 'r2', instanceId: 'B' })).toBe(true)
    expect(await a.renewSlot('f1', 'c1', { runId: 'r1', instanceId: 'A' })).toBe(false)
  })

  it('补发日志：游标接着读、阻塞读被追加叫醒；停止指令只到目标副本', async () => {
    const hub = createMemoryRunHub()
    const a = createMemoryRunRegistry({ hub, instanceId: 'A' })
    const b = createMemoryRunRegistry({ hub, instanceId: 'B' })
    const waiting = b.waitReplay('r1', null, 1000)
    await a.appendReplay('r1', { seq: 1, events: [] }, 10)
    const [first] = await waiting
    expect(first!.record.seq).toBe(1)
    await a.appendReplay('r1', { seq: 2, events: [] }, 10)
    expect((await b.readReplay('r1', first!.cursor)).map((entry) => entry.record.seq)).toEqual([2])

    const got: StopCommand[] = []
    await a.onStop((command) => got.push(command))
    await b.onStop(() => got.push({ flowId: 'wrong', runId: '', reason: '' }))
    await b.sendStop('A', { flowId: 'f1', runId: 'r1', reason: '停' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(got).toEqual([{ flowId: 'f1', runId: 'r1', reason: '停' }])
  })
})
