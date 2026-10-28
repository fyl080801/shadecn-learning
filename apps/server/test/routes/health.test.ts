import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app.ts'
import { createMemoryBackend, useBackendForTesting } from '../../cluster/index.ts'
import { prisma } from '../../db.ts'
import { health } from '../../routes/health.ts'
import { resetDb } from '../helpers/db.ts'

/**
 * 两个探针路径（docs/19 §4.6 第 3 条）。
 *
 * 拆成两条的理由是**失败时该发生的事完全相反**：readiness 失败 → 摘流量；
 * liveness 失败 → 重启容器。而重启治不了数据库故障，只会把一个还握着未落库内容的
 * 进程杀掉，然后在 CrashLoopBackOff 里反复重启。所以 liveness 必须保持浅探针 ——
 * 这组用例钉的就是「浅的真浅」。
 */

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/health（浅探针，给 liveness / startup）', () => {
  it('返回 200 和 status=ok', async () => {
    const res = await health.request('/')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('带上可解析的 uptime 和 ISO 时间戳', async () => {
    const body = (await (await health.request('/')).json()) as {
      uptime: number
      timestamp: string
    }

    expect(body.uptime).toBeTypeOf('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it('匿名可访问，且不碰数据库', async () => {
    const query = vi.spyOn(prisma, '$queryRaw')

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' })
    // 这是这条用例的重点：数据库挂了也不能让 liveness 失败
    expect(query).not.toHaveBeenCalled()
  })

  it('数据库不可用时**照样** 200 —— 重启治不了数据库故障', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('数据库炸了'))
    expect((await app.request('/api/health')).status).toBe(200)
  })
})

describe('GET /api/health/ready（深探针，给 readiness）', () => {
  it('匿名可访问 —— kubelet 不带 cookie', async () => {
    const response = await app.request('/api/health/ready')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      database: 'ok',
      cluster: 'ok',
    })
  })

  it('数据库不通 → 503，把这个 Pod 摘出 endpoints', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('数据库炸了'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await app.request('/api/health/ready')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'not-ready',
      database: 'down',
    })
  })

  it('共享层不通 → 503', async () => {
    const restore = useBackendForTesting({
      ...createMemoryBackend(),
      health: () => ({ ok: false, backend: 'redis', status: 'reconnecting' }),
    })

    try {
      const response = await app.request('/api/health/ready')
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ cluster: 'down' })
    } finally {
      restore()
    }
  })

  /**
   * 这个端点匿名可读，所以响应里只能有「通没通」。连接串、主机名、驱动错误码
   * 都只进日志（那边 module=health）。
   */
  it('失败时不把原因写进响应', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const body = await (await app.request('/api/health/ready')).text()

    expect(body).not.toContain('ECONNREFUSED')
    expect(body).not.toContain('10.0.0.5')
  })
})
