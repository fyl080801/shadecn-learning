import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app.ts'
import { collabLogging, resetCollabLogStats } from '../../logger/collab.ts'
import { resetDb } from '../helpers/db.ts'
import { actor } from '../helpers/project.ts'

/**
 * 协同监控端点。
 *
 * `/health` 是 REQ-RESILIENCE §4.5 的落点：**状态码本身就是结论**（200 / 503），
 * 这样最土的告警（curl 判状态码）也接得上，不必解析 JSON。
 */

beforeEach(async () => {
  await resetDb()
  // 落库统计是进程级累计的，不清会把别的用例造出来的失败带进来
  resetCollabLogStats()
})

describe('GET /api/collab/health', () => {
  it('未登录 → 401', async () => {
    const response = await app.request('/api/collab/health')
    expect(response.status).toBe(401)
  })

  it('一切正常 → 200，并报出落库健康度的那几个数', async () => {
    const alice = await actor()
    const response = await alice.request('/api/collab/health')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      instance: string
      store: { started: number; completed: number; failed: number; sinceLastOkMs: number | null }
      pending: number
      cluster: { ok: boolean; backend: string }
      rooms: { total: number; connections: number }
    }

    expect(body.ok).toBe(true)
    expect(body.instance).toBeTruthy()
    // 刚起的进程一次都没落过库，`lastOkAt` 为 null —— 那不算不健康
    expect(body.store.sinceLastOkMs).toBeNull()
    expect(body.store.failed).toBe(0)
    expect(body.pending).toBe(0)
    // 测试跑在单副本下，共享层就是进程内存
    expect(body.cluster).toMatchObject({ ok: true, backend: 'memory' })
    expect(body.rooms.total).toBe(0)
  })

  /**
   * 落库失败过一次就该翻脸 —— 这正是 §4.1 那类「界面写着已同步、字节其实没落库」
   * 的故障唯一能被外部看见的地方。
   */
  it('有落库失败 → 503', async () => {
    const extension = collabLogging()
    try {
      // 只有「开始」没有「完成」= 落库链中途抛了（Redis 锁失败、数据库写不进去）
      await extension.onStoreDocument?.({ documentName: 'flow:x', clientsCount: 1 } as never)

      const alice = await actor()
      const response = await alice.request('/api/collab/health')

      expect(response.status).toBe(503)
      const body = (await response.json()) as { ok: boolean; store: { failed: number } }
      expect(body.ok).toBe(false)
      expect(body.store.failed).toBeGreaterThan(0)
    } finally {
      extension.dispose()
    }
  })
})

describe('GET /api/collab/rooms', () => {
  it('未登录 → 401', async () => {
    expect((await app.request('/api/collab/rooms')).status).toBe(401)
  })

  it('没有房间时报 0', async () => {
    const alice = await actor()
    const response = await alice.request('/api/collab/rooms')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ totalRooms: 0, totalConnections: 0 })
  })
})
