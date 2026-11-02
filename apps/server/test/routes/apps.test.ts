import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import { CHAT_APP, IMAGE_APP, VIDEO_APP, stubAppsConfig } from '../helpers/apps-config.ts'
import { resetDb } from '../helpers/db.ts'
import { closeFreshOrms, importFreshApp } from '../helpers/fresh-app.ts'
import { signIn } from '../helpers/session.ts'

/**
 * `/api/apps`（docs/29 §3.6）走完整的管线：登录闸门、模块按应用表装配、错误码到 HTTP 状态的映射。
 * 全局的 test.env 里没有应用（模块不加载），这里 `stubAppsConfig()` 配上再重建一份 app；上游用 stubGlobal 的 fetch 脚本化。
 */

type App = Hono<never>
let app: App

/** 已登录的请求：先登录（写库）再重建 app —— 反过来会和新 app 装配时登录模块的过期清理抢 SQLite 的写锁 */
async function actor() {
  const { cookie } = await signIn()
  stubAppsConfig()
  app = (await importFreshApp()) as unknown as App
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...init.headers, cookie } })
  return {
    request,
    json: (path: string, method: string, body: unknown) =>
      request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }
}

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await closeFreshOrms()
})

function sse(...chunks: unknown[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe('/api/apps', () => {
  it('未登录 → 401', async () => {
    await actor()
    expect((await app.request('/api/apps')).status).toBe(401)
  })

  it('列表：每个应用的类别、驱动、参数表；缺密钥的标成不可用，不泄露提供方配置', async () => {
    const alice = await actor()
    const res = await alice.request('/api/apps')
    expect(res.status).toBe(200)
    const list = (await res.json()) as { id: string; category: string; driver: string; unavailable?: string }[]
    expect(list.map((item) => item.id)).toEqual([CHAT_APP, IMAGE_APP, VIDEO_APP])
    expect(list[0]).toMatchObject({ category: 'text', driver: 'ollama' })
    expect(list[0]!.unavailable).toBeUndefined()
    expect(list[1]).toMatchObject({ category: 'image', driver: 'ark', unavailable: expect.stringContaining('TEST_APPS_ARK_KEY') })
    expect(JSON.stringify(list)).not.toContain('11434')
  })

  it('执行：参数不对 400、没有的应用 404、不可用 503、成功回统一的结果', async () => {
    const alice = await actor()
    expect((await alice.json(`/api/apps/${CHAT_APP}/execute`, 'POST', { params: {} })).status).toBe(400)
    expect((await alice.json('/api/apps/nope/execute', 'POST', { params: {} })).status).toBe(404)
    const unavailable = await alice.json(`/api/apps/${IMAGE_APP}/execute`, 'POST', { params: { prompt: 'x' } })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ code: 'unavailable' })

    vi.stubGlobal('fetch', async () =>
      sse(
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ),
    )
    const ok = await alice.json(`/api/apps/${CHAT_APP}/execute`, 'POST', { params: { prompt: '你好' } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ appId: CHAT_APP, outputs: [{ kind: 'text', text: '好' }] })
  })

  it('上游出错 → 502，回包只有归一过的一句话', async () => {
    const alice = await actor()
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }))
    const res = await alice.json(`/api/apps/${CHAT_APP}/execute`, 'POST', { params: { prompt: '你好' } })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'upstream', error: expect.stringContaining('model not found') })
  })

  it('应用 id 带冒号：前端 encodeURIComponent 过的路径和原样的都认', async () => {
    const alice = await actor()
    const encoded = await alice.request(`/api/apps/${encodeURIComponent(CHAT_APP)}`)
    expect(encoded.status).toBe(200)
    expect(await encoded.json()).toMatchObject({ id: CHAT_APP, model: 'qwen3', title: '测试对话' })
    expect((await alice.request(`/api/apps/${CHAT_APP}`)).status).toBe(200)
    // 旧的按名字的 id 不存在了
    expect((await alice.request('/api/apps/chat')).status).toBe(404)
  })

  it('模型不是参数：传了 400，不发请求', async () => {
    const alice = await actor()
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const res = await alice.json(`/api/apps/${CHAT_APP}/execute`, 'POST', { params: { prompt: '你好', model: 'qwen3' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_params', error: expect.stringContaining('不认识的参数 model') })
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
