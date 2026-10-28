import { Hono } from 'hono'
import type { ServerEnv } from '../../app.ts'
import type { SessionUser } from '../../auth/session.ts'
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

/**
 * 按**真实挂载形态**把反代包起来：`/api/*` 上挂着 requireAuth，故走到这条路由时
 * `c.get('user')` 必然在。直接 `mount(galstory).request()` 是不真实的 —— 那等于把这条路由挪到了
 * 鉴权之外，而反代在那种情况下会（正确地）回 401 而不是继续转发。
 */
function mount(galstory: Mod['galstory'], user: { id: string } | null = { id: 'u1' }) {
  // 反代只读 `user.id`，故这里造一个最小的登录态即可；`as` 是为了不必在测试里把
  // SessionUser 那七个字段全填一遍（填了反而看不出这条用例真正依赖的是哪一个）。
  const app = new Hono<ServerEnv>()
  app.use('*', async (c, next) => {
    c.set('user', user as SessionUser | null)
    await next()
  })
  app.route('/', galstory)
  return app
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GAL_STORY_API_URL
  delete process.env.GAL_STORY_API_TIMEOUT_MS
})

describe('GalStory 反代', () => {
  it('没配 GAL_STORY_API_URL → 503 且说清该设哪个变量', async () => {
    const { galstory } = await load({ GAL_STORY_API_URL: undefined })

    const res = await mount(galstory).request('/stories')

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ hint: expect.stringContaining('GAL_STORY_API_URL') })
  })

  it('GET 转发到引擎的 /api 之下，带上原样的查询串', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }))
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000/' })

    await mount(galstory).request('/saves?story=rainy_inn')

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

    const res = await mount(galstory).request('/saves/x/state')

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ detail: '这一局还没装配——先 POST …' })
  })

  it('没在 WRITE_ALLOW 里逐条登记过的非 GET 一律 405，且根本不发上游', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/saves/x/rollback', { method: 'POST' })

    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('连不上引擎 → 502，并说该去确认什么', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/stories')

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

    const res = await mount(galstory).request('/stories')

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('1234ms') })
  })
})

describe('上游回 204 时不许把成功报成失败', () => {
  /**
   * ⚠️⚠️ 这一条是实跑逼出来的：删存档的 `DELETE /saves/{id}` 回 **204**，而
   * `new Response('', { status: 204 })` 在 undici 上**直接抛 TypeError**（规范：204/205/304
   * 不能带 body）。那个异常被反代的 catch 接住、报成「连不上 GalStory 后端」——
   * 于是**一个已经成功的删除**在界面上显示成「后端挂了」，而存档其实已经没了。
   *
   * 误诊比不诊贵：它把人引向「重启引擎」，而该修的在这一层。
   */
  it('204 原样是 204，且不带 body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/saves/abc?confirm=true', { method: 'DELETE' })

    expect(res.status).toBe(204)
    await expect(res.text()).resolves.toBe('')
  })

  it('**拿到过响应就不是「连不上」** —— 本层出的错要如实说是本层', async () => {
    // 上游明明答复了，只是本层读 body 时炸了。报成「连不上」会让人去重启引擎。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.reject(new Error('body 读炸了')),
    }) as unknown as Response)
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/stories')

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body.hint).toBe('body 读炸了')
    expect(body.error).not.toContain('连不上')
  })
})

describe('写口逐条放行，其余的非 GET 仍然拦住', () => {
  /**
   * ⚠️ **每次调用都要现造一个 Response**：body 是一次性的流，`mockResolvedValue(ok())` 会让
   * 所有调用共用同一个实例，第二次读就抛「body disturbed」，而反代把它当成连不上上游 → 502。
   * 那是测试自己造出来的假象，不是被测代码的行为。
   */
  function okEachTime() {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      )
  }

  it('配置那一族的 PATCH / PUT / DELETE 转发过去', async () => {
    const fetchMock = okEachTime()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const cases: ReadonlyArray<[string, string]> = [
      ['PATCH', '/config'],
      ['PUT', '/config/connections/base'],
      ['DELETE', '/config/connections/base'],
      ['PUT', '/config/presets/default'],
      ['DELETE', '/config/presets/default'],
      ['PUT', '/config/agents/plan'],
      ['DELETE', '/config/agents/plan'],
    ]
    for (const [method, path] of cases) {
      const res = await mount(galstory).request(path, { method, body: '{}' })
      expect(res.status, `${method} ${path} 该被放行`).toBe(200)
    }
    expect(fetchMock).toHaveBeenCalledTimes(cases.length)
  })

  it('写请求要把 content-type 带过去，否则请求体到不了 FastAPI 的模型那一层', async () => {
    const fetchMock = okEachTime()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    await mount(galstory).request('/config', {
      method: 'PATCH',
      body: '{"verify":true}',
      headers: { 'content-type': 'application/json' },
    })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('回退与切线仍然 405 —— 它们会整个换掉 state/，而界面上还没有对应的入口', async () => {
    // ⚠️ 对局那几条（open / turns / delete / 建存档）**已经放行**，见 WRITE_ALLOW 里那一段：
    // 它们要花钱、会删数据，前提是每条转发都带着 X-Gal-Owner，由引擎按属主分目录隔离。
    // 这条用例守的是「没被顺手一起开掉」的那几条。
    const fetchMock = okEachTime()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    for (const [method, path] of [
      ['POST', '/saves/x/rollback'],
      ['POST', '/saves/x/switch-line'],
    ] as const) {
      const res = await mount(galstory).request(path, { method, body: '{}' })
      expect(res.status, `${method} ${path} 不该被放行`).toBe(405)
    }
    // 拦下的请求**根本不发上游** —— 405 是这一层给的，不是引擎给的
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('放行的正则两端都锚定：再往下钻一层就不认了', async () => {
    okEachTime()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/config/connections/base/secret', {
      method: 'PUT',
      body: '{}',
    })

    expect(res.status).toBe(405)
  })
})

describe('用户 ↔ 故事实例的关联', () => {
  function okEach() {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        new Response('[]', { headers: { 'content-type': 'application/json' } }),
      )
  }

  it('每条转发都带上登录用户的 id 当属主 —— 这就是全部的关联逻辑', async () => {
    const fetchMock = okEach()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    await mount(galstory, { id: 'clv0user0001' }).request('/saves')

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Gal-Owner']).toBe('clv0user0001')
  })

  it('两个用户拿到的是各自的属主头 —— 引擎按它分目录，越权在结构上就不成立', async () => {
    const fetchMock = okEach()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    await mount(galstory, { id: 'userA' }).request('/saves')
    await mount(galstory, { id: 'userB' }).request('/saves')

    const owners = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    )
    expect(owners[0]?.['X-Gal-Owner']).toBe('userA')
    expect(owners[1]?.['X-Gal-Owner']).toBe('userB')
  })

  it('没有登录态时宁可 401，也不匿名落到引擎的缺省属主上（那是所有人共用一个）', async () => {
    const fetchMock = okEach()
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory, null).request('/saves')

    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('配了网关密钥就带上 —— 挡住绕过本服务直连引擎的请求', async () => {
    const fetchMock = okEach()
    const { galstory } = await load({
      GAL_STORY_API_URL: 'http://engine:8000',
      GAL_STORY_GATEWAY_TOKEN: 's3cret',
    })

    await mount(galstory, { id: 'u1' }).request('/saves')

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Gal-Gateway-Token']).toBe('s3cret')
  })

  it('没配密钥就不带这个头（别发一个空串过去）', async () => {
    const fetchMock = okEach()
    const { galstory } = await load({
      GAL_STORY_API_URL: 'http://engine:8000',
      GAL_STORY_GATEWAY_TOKEN: undefined,
    })

    await mount(galstory, { id: 'u1' }).request('/saves')

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect('X-Gal-Gateway-Token' in headers).toBe(false)
  })
})

describe('事件流不能被缓冲', () => {
  it('SSE 响应直接把 body 接出去，而不是攒完再一次性吐', async () => {
    // 攒完再吐的话，进度事件的全部意义（边跑边看）就没了：一轮几十秒，
    // 客户端在结束前一个字都收不到，与「引擎卡住了」在界面上一模一样。
    const chunks = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n']
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[pulled++]!))
        else controller.close()
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const { galstory } = await load({ GAL_STORY_API_URL: 'http://engine:8000' })

    const res = await mount(galstory).request('/saves/x/events')

    expect(res.headers.get('content-type')).toContain('text/event-stream')
    // 反代不得自己缓冲；同时那三个头要带上，否则链路上任何一层都可能替我们缓冲
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    await expect(res.text()).resolves.toContain('RUN_FINISHED')
  })
})
