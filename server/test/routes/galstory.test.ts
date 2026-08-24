import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * GalStory 反代（server/routes/galstory.ts）。
 *
 * 地址是模块级常量（从 env 读一次），所以每个用例都要 resetModules 重新 import —— 与
 * `src/test/lib/auth.test.ts` 那边同一个手法。
 */

type Mod = typeof import('../../routes/galstory.ts')

async function load(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return (await import('../../routes/galstory.ts')) as Mod
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GAL_STORY_API_URL
  delete process.env.GAL_STORY_API_TIMEOUT_MS
})

describe('GalStory 反代', () => {
  it('没配 GAL_STORY_API_URL → 503 且说清该设哪个变量', async () => {
    const { galstory } = await load({ GAL_STORY_API_URL: undefined })

    const res = await galstory.request('/stories')

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ hint: expect.stringContaining('GAL_STORY_API_URL') })
  })

  it('GET 转发到引擎的 /api 之下，带上原样的查询串', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }))
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000/' })

    await galstory.request('/saves?story=rainy_inn')

    // 末尾斜杠在解析时就去掉了，故拼出来的地址只有一种写法
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://engine:8000/api/saves?story=rainy_inn')
  })

  it('上游的状态码与响应体原样透传 —— 引擎的 409 自带说人话的 detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: '这一局还没装配——先 POST …' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await galstory.request('/saves/x/state')

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ detail: '这一局还没装配——先 POST …' })
  })

  it('非 GET 一律 405 —— 引擎把「要花钱 / 会写」的口都放在非 GET 上', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await galstory.request('/saves/x/open', { method: 'POST' })

    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('连不上引擎 → 502，并说该去确认什么', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await galstory.request('/stories')

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ hint: expect.stringContaining('gal-story serve') })
  })

  it('上游超时 → 502，且文案里给出那个上界（fetch 本身没有上界，不给就永远挂着）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    )
    const { galstory } = await load({
      GAL_STORY_API_URL: 'http://engine:8000',
      GAL_STORY_API_TIMEOUT_MS: '1234',
    })

    const res = await galstory.request('/stories')

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('1234ms') })
  })
})
