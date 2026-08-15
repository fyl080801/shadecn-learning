import { describe, expect, it } from 'vitest'
import { health } from '../../routes/health.ts'

describe('GET /api/health', () => {
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
})
