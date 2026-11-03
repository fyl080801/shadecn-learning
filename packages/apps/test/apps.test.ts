import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { anonymous, type Actor, bootAppsApp, CHAT_APP, createActor, IMAGE_APP, TEST_APPS, VIDEO_APP } from './helpers.js'

/**
 * `/api/apps`（docs/29 §3.6）走完整的管线：登录、错误码到 HTTP 状态的映射。上游用 stubGlobal 的 fetch 脚本化。从 `apps/server/test/routes/apps.test.ts` 移植。
 */
function sse(...chunks: unknown[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe('/api/apps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-routes-'))
  let app: NestFastifyApplication
  let alice: Actor

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 不设方舟的 key：这几个应用是不可用的
    app = await bootAppsApp({ databaseUrl: `file:${path.join(dir, 'test.db')}`, values: { llm: {} }, env: { TEST_APPS_ARK_KEY: '' } })
    alice = await createActor(app)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('未登录 → 401', async () => {
    expect((await anonymous(app, '/api/apps')).status).toBe(401)
    expect((await anonymous(app, `/api/apps/${encodeURIComponent(CHAT_APP)}`)).status).toBe(401)
    expect((await anonymous(app, `/api/apps/${encodeURIComponent(CHAT_APP)}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  })

  it('列表：每个应用的类别、驱动、参数表；缺密钥的标成不可用，不泄露提供方配置', async () => {
    const res = await alice.request('/api/apps')
    expect(res.status).toBe(200)
    const list = res.json<{ id: string; category: string; driver: string; unavailable?: string }[]>()
    expect(list.map((item) => item.id)).toEqual([CHAT_APP, IMAGE_APP, VIDEO_APP])
    expect(list[0]).toMatchObject({ category: 'text', driver: 'ollama' })
    expect(list[0].unavailable).toBeUndefined()
    expect(list[1]).toMatchObject({ category: 'image', driver: 'ark', unavailable: expect.stringContaining('TEST_APPS_ARK_KEY') })
    expect(res.text).not.toContain('11434')
  })

  it('执行：参数不对 400、没有的应用 404、不可用 503、成功回统一的结果', async () => {
    const send = (appId: string, body: unknown) => alice.json(`/api/apps/${encodeURIComponent(appId)}/execute`, 'POST', body)
    expect((await send(CHAT_APP, { params: {} })).status).toBe(400)
    expect((await send('nope', { params: {} })).status).toBe(404)
    const unavailable = await send(IMAGE_APP, { params: { prompt: 'x' } })
    expect(unavailable.status).toBe(503)
    expect(unavailable.json()).toMatchObject({ code: 'unavailable' })

    vi.stubGlobal('fetch', async () =>
      sse(
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ),
    )
    const ok = await send(CHAT_APP, { params: { prompt: '你好' } })
    expect(ok.status).toBe(200)
    expect(ok.json()).toMatchObject({ appId: CHAT_APP, outputs: [{ kind: 'text', text: '好' }] })
  })

  it('请求体不是 { params: 对象 } → 400；坏 JSON 也是 400（Fastify 在路由之前拦下，形状是 Nest 默认的）', async () => {
    const url = `/api/apps/${encodeURIComponent(CHAT_APP)}/execute`
    expect((await alice.json(url, 'POST', { params: [1] })).json()).toMatchObject({ code: 'invalid_params' })
    expect((await alice.json(url, 'POST', { params: 'x' })).status).toBe(400)
    expect((await alice.json(url, 'POST')).status).toBe(400)
    expect((await alice.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })).status).toBe(400)
  })

  it('上游出错 → 502，回包只有归一过的一句话', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }))
    const res = await alice.json(`/api/apps/${encodeURIComponent(CHAT_APP)}/execute`, 'POST', { params: { prompt: '你好' } })
    expect(res.status).toBe(502)
    expect(res.json()).toMatchObject({ code: 'upstream', error: expect.stringContaining('model not found') })
  })

  it('应用 id 带冒号：前端 encodeURIComponent 过的路径和原样的都认', async () => {
    const encoded = await alice.request(`/api/apps/${encodeURIComponent(CHAT_APP)}`)
    expect(encoded.status).toBe(200)
    expect(encoded.json()).toMatchObject({ id: CHAT_APP, model: 'qwen3', title: '测试对话' })
    expect((await alice.request(`/api/apps/${CHAT_APP}`)).status).toBe(200)
    expect((await alice.request('/api/apps/chat')).status).toBe(404)
  })

  it('模型不是参数：传了 400，不发请求', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const res = await alice.json(`/api/apps/${encodeURIComponent(CHAT_APP)}/execute`, 'POST', { params: { prompt: '你好', model: 'qwen3' } })
    expect(res.status).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_params', error: expect.stringContaining('不认识的参数 model') })
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('客户端断开 = 中止这次执行：上游请求的信号被中止（走真的 HTTP）', async () => {
    let upstream: AbortSignal | undefined
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      upstream = init?.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        upstream!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const { hostname, port } = new URL(await app.getUrl())
    const payload = JSON.stringify({ params: { prompt: '你好' } })
    const request = http.request({
      hostname,
      port,
      method: 'POST',
      path: `/api/apps/${encodeURIComponent(CHAT_APP)}/execute`,
      headers: { cookie: alice.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    })
    request.on('error', () => undefined)
    request.end(payload)
    await vi.waitFor(() => expect(upstream).toBeDefined(), { timeout: 5000 })
    expect(upstream?.aborted).toBe(false)
    request.destroy()
    await vi.waitFor(() => expect(upstream?.aborted).toBe(true), { timeout: 5000 })
  })
})

describe('一个应用都没配', () => {
  it('服务照常启动：列表是空的，任务列表是空的，提交 404', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-empty-'))
    const app = await bootAppsApp({ databaseUrl: `file:${path.join(dir, 'test.db')}`, values: { apps: undefined, llm: undefined } })
    try {
      const alice = await createActor(app)
      expect((await alice.request('/api/apps')).json()).toEqual([])
      const { id: projectId } = (await alice.json('/api/projects', 'POST', { name: 'p' })).json<{ id: string }>()
      const { id: flowId } = (await alice.json(`/api/projects/${projectId}/flows`, 'POST', { name: 'f' })).json<{ id: string }>()
      expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).json()).toMatchObject({ tasks: [], now: expect.any(Number) })
      expect((await alice.json(`/api/flows/${flowId}/apps/${encodeURIComponent(CHAT_APP)}/execute`, 'POST', { params: {}, nodeId: 'n' })).status).toBe(404)
      expect(TEST_APPS.apps.length).toBeGreaterThan(0)
    } finally {
      await app.close()
      fs.rmSync(dir, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})
