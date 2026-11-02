import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import * as Y from 'yjs'
import type { AppTaskView } from '@shadecn/shared/apps'
import { fromYNode, nodesMap } from '@shadecn/shared/flow-doc'
import { emptyGraph, type FlowNodeRecord } from '@shadecn/shared/flow-graph'
import { AppTask } from '@shadecn/mod-apps/entities'
import { loadFlowState, roomOf } from '@shadecn/mod-collab/persistence'
import type { S3Client } from '@shadecn/mod-storage/s3'
import { buildAssetKey } from '@shadecn/mod-storage/keys'
import { FlowAsset } from '@shadecn/mod-storage/entities'
import { CHAT_APP, IMAGE_APP, VIDEO_APP, stubAppsConfig } from '../helpers/apps-config.ts'
import { writeGraph } from '../helpers/collab.ts'
import { db, resetDb } from '../helpers/db.ts'
import { closeFreshOrms, importFreshApp } from '../helpers/fresh-app.ts'
import { actor as projectActor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * 画布节点的生成任务 `/api/flows/:flowId/apps`（docs/29 §3.8、§3.10）：
 * 提交即返回 202 + 任务，执行在 agent 角色（测试里是同一个全角色进程，照样经总线派发）；
 * 画布守卫（非成员 404）、参考图里**本画布的资源**换成字节（不请求那个地址）、外部地址原样交给驱动、
 * 图片产物存成本画布的资源，**由服务端写回节点**（`src` / `runtime`）；失败、409、取消、续查。
 *
 * 全局 test.env 里没有应用表，这里 stubEnv 指到 fixture 再重建 app；对象存储换成假的（换的是新模块图里那一份）。
 */

type App = Hono<never>

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeS3() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>()
  const client: S3Client = {
    objectUrl: (key) => `https://s3.example.test/canvas-bucket/${key}`,
    async putObject(key, body, contentType) {
      objects.set(key, { body, contentType })
      return client.objectUrl(key)
    },
    async headObject(key) {
      const found = objects.get(key)
      return found ? { size: found.body.byteLength, contentType: found.contentType } : null
    },
    async getObject(key) {
      const found = objects.get(key)
      return found ? { status: 'ok', body: found.body, contentType: found.contentType } : { status: 'not_found' }
    },
    createMultipartUpload: async () => 'x',
    uploadPart: async () => 'x',
    completeMultipartUpload: async () => 'x',
    abortMultipartUpload: async () => {},
  }
  return { client, objects }
}

let s3 = fakeS3()

/**
 * 建好项目、画布和一个图片 / 视频节点，放好资源，**最后**才带着 ARK key 重建一份装了应用模块的 app ——
 * 写库都在重建之前：新 app 装配时登录模块的过期清理会占 SQLite 的写锁（`.claude/rules/apps.md`）
 */
async function setup(env: Record<string, string> = {}) {
  const alice = await projectActor('alice')
  const projectId = await createProject(alice)
  const flowId = await createFlow(alice, projectId)
  const otherFlowId = await createFlow(alice, projectId, '另一张')
  const bob = await projectActor('bob')
  const carol = await projectActor('carol')
  await joinViaInvite(alice, projectId, carol)
  const own = await ownAsset(flowId, alice.userId)
  const foreign = await ownAsset(otherFlowId, alice.userId)
  const graph = emptyGraph()
  graph.nodes.push(nodeRecord('n_img', 'image'), nodeRecord('n_vid', 'video'), nodeRecord('n_txt', 'text'), {
    ...nodeRecord('n_txt_filled', 'text'),
    data: { text: '我写的字' },
  })
  await writeGraph(flowId, graph)
  stubAppsConfig()
  vi.stubEnv('TEST_APPS_ARK_KEY', 'ark-key')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  const app = (await importFreshApp()) as unknown as App
  const { replaceAssetStorage } = await import('@shadecn/mod-storage')
  replaceAssetStorage(s3.client)
  const as = (cookie: string) => (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  /** 管理员把 carol 移出项目（路由会 await `revokeAccess()`） */
  const removeCarol = () =>
    app.request(`/api/projects/${projectId}/members/${carol.userId}`, { method: 'DELETE', headers: { cookie: alice.cookie } })
  return { app, flowId, own, foreign, alice: as(alice.cookie), bob: as(bob.cookie), carol: as(carol.cookie), removeCarol }
}

function nodeRecord(id: string, type: string): FlowNodeRecord {
  return { id, type, layout: { position: { x: 0, y: 0 } }, metadata: { label: id }, data: {}, runtime: { status: 'idle' } }
}

/** 往假存储里放一张属于这张画布的图（和上传接口落下的一样：对象 + FlowAsset 记录） */
async function ownAsset(flowId: string, userId: string) {
  const key = buildAssetKey('canvas', { name: 'ref.png', contentType: 'image/png' })
  s3.objects.set(key, { body: PNG, contentType: 'image/png' })
  const em = db()
  em.create(FlowAsset, { key, flow: flowId, contentType: 'image/png', createdById: userId })
  await em.flush()
  return s3.client.objectUrl(key)
}

interface ArkScript {
  /** 生图失败（上游 400） */
  imageFails?: boolean
  /** 视频任务查几次之后成功；Infinity = 一直在跑 */
  videoRunsFor?: number
}

function arkUpstream(script: ArkScript = {}) {
  const requests: { url: string; method: string; body: unknown }[] = []
  let polls = 0
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    if (url.endsWith('/images/generations')) {
      if (script.imageFails) return json({ error: { message: '提示词不合规' } }, 400)
      return json({ data: [{ url: 'https://ark-cdn.example/out.png', size: '2048x2048' }] })
    }
    if (url.endsWith('/contents/generations/tasks') && method === 'POST') return json({ id: 'cgt-1' })
    if (url.endsWith('/contents/generations/tasks/cgt-1')) {
      if (method === 'DELETE') return new Response(null, { status: 200 })
      polls += 1
      if (polls <= (script.videoRunsFor ?? 1)) return json({ id: 'cgt-1', status: polls === 1 ? 'queued' : 'running' })
      return json({ id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://ark-cdn.example/out.mp4', last_frame_url: 'https://ark-cdn.example/last.png' } })
    }
    if (url === 'https://ark-cdn.example/out.png' || url === 'https://ark-cdn.example/last.png') {
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }
    if (url === 'https://ark-cdn.example/out.mp4') return new Response(new Uint8Array([0, 0, 0, 1]), { headers: { 'content-type': 'video/mp4' } })
    throw new Error(`[test] 未打桩的出站请求：${url}`)
  })
  return requests
}

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`[test] 等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 库里的画布内容里的一个节点（服务端写回、断开连接时落库） */
async function storedNode(flowId: string, nodeId: string) {
  const state = await loadFlowState(roomOf(flowId))
  if (!state) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const node = nodesMap(doc).get(nodeId)
  const record = node instanceof Y.Map ? fromYNode(nodeId, node as Y.Map<unknown>) : null
  doc.destroy()
  return record
}

const taskRow = (id: string) => db().fork().findOne(AppTask, { id })
const taskDone = (id: string) => until(async () => {
  const row = await taskRow(id)
  return row && !['queued', 'running'].includes(row.status) ? row : null
}, `任务 ${id} 结束`)

async function submit(as: (path: string, body?: unknown) => Response | Promise<Response>, flowId: string, appId: string, body: unknown) {
  const res = await as(`/api/flows/${flowId}/apps/${encodeURIComponent(appId)}/execute`, body)
  return { res, task: res.status === 202 ? ((await res.json()) as { task: AppTaskView }).task : null }
}

beforeEach(async () => {
  await resetDb()
  s3 = fakeS3()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await closeFreshOrms()
})

describe('POST /api/flows/:flowId/apps/:appId/execute（提交生成任务）', () => {
  it('不是这张画布的成员 → 404（画布守卫），不建任务、不调上游', async () => {
    const { flowId, bob } = await setup()
    const requests = arkUpstream()
    const { res } = await submit(bob, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
    expect(res.status).toBe(404)
    expect(requests).toHaveLength(0)
    expect(await db().count(AppTask, {})).toBe(0)
  })

  it('参数不对 / 缺 nodeId → 400，当场报、不建任务', async () => {
    const { flowId, alice } = await setup()
    arkUpstream()
    expect((await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', nope: 1 }, nodeId: 'n_img' })).res.status).toBe(400)
    expect((await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' } })).res.status).toBe(400)
    expect((await submit(alice, flowId, 'missing', { params: {}, nodeId: 'n_img' })).res.status).toBe(404)
    expect(await db().count(AppTask, {})).toBe(0)
  })

  it('202 + 任务；服务端执行：本画布的参考图换 data URL、外部地址原样；产物存成资源并写回节点', async () => {
    const { flowId, alice, own } = await setup()
    const requests = arkUpstream()
    const { res, task } = await submit(alice, flowId, IMAGE_APP, {
      params: { prompt: '把图1换成图2的风格', image: [own, 'https://elsewhere.example/b.png'] },
      nodeId: 'n_img',
    })
    expect(res.status).toBe(202)
    expect(task).toMatchObject({ flowId, nodeId: 'n_img', appId: IMAGE_APP, appTitle: '测试文生图', owner: { name: expect.any(String) } })

    const row = await taskDone(task!.id)
    expect(row.status).toBe('succeeded')
    const sent = requests.find((request) => request.url.endsWith('/images/generations'))!.body as { image: string[] }
    expect(sent.image[0]).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(sent.image[1]).toBe('https://elsewhere.example/b.png')
    // 本画布的资源是按键从存储读的，没有去请求那个地址
    expect(requests.some((request) => request.url === own)).toBe(false)

    const [output] = JSON.parse(row.outputs!) as { url: string; meta: { assetKey: string } }[]
    expect(output!.url).toMatch(/^https:\/\/s3\.example\.test\/canvas-bucket\/canvas\/assets\//)
    expect(await db().findOne(FlowAsset, { key: output!.meta.assetKey, flow: flowId })).toMatchObject({ contentType: 'image/png' })

    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_img')
      return found?.runtime.status === 'completed' ? found : null
    }, '节点被写回')
    expect(node.data).toMatchObject({ src: output!.url, form: 'asset' })
    // 结果同时留进生成历史（gen.<taskId>）
    expect(node.data[`gen.${task!.id}`]).toMatchObject({ src: output!.url, createdAt: expect.any(Number) })
    expect(node.runtime).toMatchObject({ status: 'completed', taskId: task!.id })
    expect(node.runtime.error).toBeUndefined()
  })

  it('别的画布的资源不换成字节（归属对不上 = 不是我们的资源）', async () => {
    const { flowId, alice, foreign } = await setup()
    const requests = arkUpstream()
    const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', image: [foreign] }, nodeId: 'n_img' })
    await taskDone(task!.id)
    const sent = requests.find((request) => request.url.endsWith('/images/generations'))!.body as { image: string }
    expect(sent.image).toBe(foreign)
  })

  it('没有对象存储：产物原样，节点挂的是上游地址', async () => {
    const { flowId, alice } = await setup()
    const { replaceAssetStorage } = await import('@shadecn/mod-storage')
    replaceAssetStorage(null)
    arkUpstream()
    const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
    await taskDone(task!.id)
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_img')
      return found?.runtime.status === 'completed' ? found : null
    }, '节点被写回')
    expect(node.data.src).toBe('https://ark-cdn.example/out.png')
  })

  it('上游失败：任务 failed，节点 runtime 是 error + 原因', async () => {
    const { flowId, alice } = await setup()
    arkUpstream({ imageFails: true })
    const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
    const row = await taskDone(task!.id)
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('提示词不合规') })
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_img')
      return found?.runtime.status === 'error' ? found : null
    }, '节点写上错误')
    expect(node.runtime).toMatchObject({ taskId: task!.id, error: expect.stringContaining('提示词不合规') })
    expect(node.data.src).toBeUndefined()
  })

  it('视频任务：句柄存表、进度可查、完成后视频 + 尾帧预览图写回节点', async () => {
    const { flowId, alice } = await setup()
    arkUpstream({ videoRunsFor: 3 })
    const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    const running = await until(async () => {
      const row = await taskRow(task!.id)
      return row?.handle && row.progress ? row : null
    }, '句柄和进度存进任务表')
    expect(JSON.parse(running.handle!)).toEqual({ upstreamId: 'cgt-1' })
    await taskDone(task!.id)
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_vid')
      return found?.runtime.status === 'completed' ? found : null
    }, '视频节点被写回')
    expect(node.data.src).toMatch(/canvas-bucket/)
    expect(node.data.poster).toMatch(/canvas-bucket/)
  })
})

describe('文本节点用语言服务生成（docs/29 §3.8）', () => {
  /** OpenAI 兼容的上游：一段流式回复；记下请求 */
  function chatUpstream(content: string) {
    const requests: { url: string; authorization: string | null; body: { model: string } }[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)) as { model: string },
      })
      const chunks = [
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想一想', content } }] },
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]
      const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    return requests
  }

  const completedNode = (flowId: string, nodeId: string, status = 'completed') =>
    until(async () => {
      const found = await storedNode(flowId, nodeId)
      return found?.runtime.status === status ? found : null
    }, `节点 ${nodeId} 变成 ${status}`)

  const LLM_PROVIDERS = JSON.stringify({
    selfhost: {
      name: '自建端点',
      baseUrl: 'http://llm.internal/v1',
      api: 'openai-completions',
      apiKey: '$TEST_LLM_KEY',
      models: [{ id: 'qwen3', name: '千问 3' }, { id: 'qwen-vl', input: ['text', 'image'] }],
    },
  })

  it('llm.providers 里带模型的提供方自动成为 text 应用：节点选它生成，文字由服务端写进 data.text，思考不进节点', async () => {
    const { flowId, alice } = await setup({ LLM_PROVIDERS, TEST_LLM_KEY: 'llm-key' })
    const requests = chatUpstream('生成的文字')

    const list = (await (await alice('/api/apps')).json()) as { id: string; model?: string; title: string; category: string; params: Record<string, unknown> }[]
    // 每个模型一条：吃不吃图各看各的（同一提供方有吃图的模型时，不吃图的那个去掉 images）
    const generated = list.filter((item) => item.id.startsWith('llm-selfhost:'))
    expect(generated.map((item) => [item.id, item.title, item.category, item.model, 'images' in item.params])).toEqual([
      ['llm-selfhost:qwen3', '千问 3', 'text', 'qwen3', false],
      ['llm-selfhost:qwen-vl', 'qwen-vl', 'text', 'qwen-vl', true],
    ])

    const { res, task } = await submit(alice, flowId, 'llm-selfhost:qwen-vl', { params: { prompt: '写一句诗' }, nodeId: 'n_txt' })
    expect(res.status).toBe(202)
    // 任务表的 model 列照旧记下这个应用的模型
    expect(task).toMatchObject({ appId: 'llm-selfhost:qwen-vl', appTitle: 'qwen-vl', model: 'qwen-vl' })
    expect((await taskDone(task!.id)).status).toBe('succeeded')
    expect(requests[0]).toMatchObject({ url: 'http://llm.internal/v1/chat/completions', authorization: 'Bearer llm-key', body: { model: 'qwen-vl' } })

    const node = await completedNode(flowId, 'n_txt')
    expect(node.data.text).toBe('生成的文字')
    expect(JSON.stringify(node.data)).not.toContain('先想一想')
    expect(Object.keys(node.data).filter((key) => key.startsWith('gen.'))).toEqual([])
    // 任务表里的产物照原样，文字不丢
    const [output] = JSON.parse((await taskRow(task!.id))!.outputs!) as { kind: string; text: string }[]
    expect(output).toMatchObject({ kind: 'text', text: '生成的文字' })
  })

  it('模型 id 里带冒号的（ollama 的写法）：应用 id 经编码能走通整条提交路径', async () => {
    const withColon = JSON.stringify({
      selfhost: { baseUrl: 'http://llm.internal/v1', api: 'openai-completions', apiKey: '$TEST_LLM_KEY', models: [{ id: 'deepseek-v4.1-flash:1017-cloud' }] },
    })
    const { flowId, alice } = await setup({ LLM_PROVIDERS: withColon, TEST_LLM_KEY: 'llm-key' })
    const requests = chatUpstream('生成的文字')
    const { res, task } = await submit(alice, flowId, 'llm-selfhost:deepseek-v4.1-flash:1017-cloud', { params: { prompt: 'x' }, nodeId: 'n_txt' })
    expect(res.status).toBe(202)
    expect((await taskDone(task!.id)).status).toBe('succeeded')
    expect(requests[0]!.body.model).toBe('deepseek-v4.1-flash:1017-cloud')
  })

  it('节点上已有正文：生成的文字接在后面，不覆盖', async () => {
    const { flowId, alice } = await setup()
    chatUpstream('生成的文字')
    const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_txt_filled' })
    await taskDone(task!.id)
    expect((await completedNode(flowId, 'n_txt_filled')).data.text).toBe('我写的字\n\n生成的文字')
  })

  it('模型回了空文字：节点 error，正文不动', async () => {
    const { flowId, alice } = await setup()
    chatUpstream('')
    const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_txt_filled' })
    await taskDone(task!.id)
    const node = await completedNode(flowId, 'n_txt_filled', 'error')
    expect(node.runtime.error).toBe('应用没有返回可以放进这个节点的结果')
    expect(node.data.text).toBe('我写的字')
  })

  it('文字应用落到不输出文字的节点上（绕过界面）：节点 error，不写 data.text', async () => {
    const { flowId, alice } = await setup()
    chatUpstream('生成的文字')
    const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
    await taskDone(task!.id)
    const node = await completedNode(flowId, 'n_img', 'error')
    expect(node.data.text).toBeUndefined()
  })

  it('llm.providers 不合法 → 重建 app 就失败（真实启动同理：不监听端口），报错不带 apiKey 的值', async () => {
    const secret = 'sk-real-secret-in-config'
    vi.stubEnv('LLM_PROVIDERS', JSON.stringify({ selfhost: { apiKey: secret } }))
    const rejection = await importFreshApp().then(
      () => null,
      (err: Error) => err,
    )
    expect(rejection?.message).toContain('llm.providers.selfhost.apiKey 只能写成')
    expect(rejection?.message).not.toContain(secret)
  })
})

describe('任务列表与取消', () => {
  it('同一个节点已有进行中的任务 → 409；列表里有它和进度', async () => {
    const { flowId, alice } = await setup()
    arkUpstream({ videoRunsFor: Infinity })
    const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    await until(async () => (await taskRow(task!.id))?.progress, '有进度')
    expect((await submit(alice, flowId, VIDEO_APP, { params: { prompt: '再来' }, nodeId: 'n_vid' })).res.status).toBe(409)

    const list = (await (await alice(`/api/flows/${flowId}/apps/tasks`)).json()) as { tasks: AppTaskView[]; now: number }
    expect(list.tasks).toHaveLength(1)
    expect(list.tasks[0]).toMatchObject({ id: task!.id, status: 'running', progress: { status: expect.any(String) } })
    expect(list.now).toEqual(expect.any(Number))

    await alice(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, {})
    await taskDone(task!.id)
  })

  it('取消：别的成员 403；发起人取消 → canceled、撤上游任务、节点回到 idle；再取消 204（幂等）', async () => {
    const { flowId, alice, carol } = await setup()
    const requests = arkUpstream({ videoRunsFor: Infinity })
    const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    await until(async () => (await taskRow(task!.id))?.handle, '上游任务建好')
    await until(async () => (await storedNode(flowId, 'n_vid'))?.runtime.status === 'processing' || null, '节点在生成中', 5_000).catch(() => null)

    expect((await carol(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, {})).status).toBe(403)
    expect((await alice(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, {})).status).toBe(204)
    expect((await taskDone(task!.id)).status).toBe('canceled')
    await until(async () => requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/tasks/cgt-1')), '撤销上游任务')
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_vid')
      return found?.runtime.status === 'idle' ? found : null
    }, '节点回到 idle')
    expect(node.data.src).toBeUndefined()
    expect((await alice(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, {})).status).toBe(204)
    const list = (await (await alice(`/api/flows/${flowId}/apps/tasks`)).json()) as { tasks: AppTaskView[] }
    expect(list.tasks).toEqual([])
  })
})

describe('执行身份：凭发起人', () => {
  it('执行中发起人被移出项目：当场叫停 —— 撤上游任务、任务记失败，不再写节点', async () => {
    const { flowId, carol, removeCarol } = await setup()
    const requests = arkUpstream({ videoRunsFor: Infinity })
    const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    await until(async () => (await taskRow(task!.id))?.handle, '上游任务建好')

    expect((await removeCarol()).status).toBe(204)
    const row = await taskDone(task!.id)
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('失去这张画布的访问权限') })
    await until(async () => requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/tasks/cgt-1')), '撤销上游任务')
    // 节点停在执行副本接手时写的 processing：失权之后不再以发起人的身份写
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_vid')
      return found?.runtime.taskId === task!.id ? found : null
    }, '节点落库')
    expect(node.runtime.status).toBe('processing')
    expect(node.data.src).toBeUndefined()
  })
})

describe('续查（进程重启后接手）', () => {
  /** 一条「上一个进程留下的」任务：在跑、租约已过期 */
  async function orphan(flowId: string, userId: string, appId: string, nodeId: string, handle: object | null) {
    const em = db().fork()
    const row = em.create(AppTask, {
      flowId, nodeId, userId, appId, model: null, params: JSON.stringify({ prompt: '海浪' }), status: 'running',
      progress: null, handle: handle ? JSON.stringify(handle) : null, error: null, outputs: null,
      leaseOwner: 'dead-instance', leaseUntil: new Date(Date.now() - 1_000), startedAt: new Date(), finishedAt: null,
    })
    await em.flush()
    return row.id
  }

  it('有续查句柄：接着查（不重新提交），完成后写回节点', async () => {
    const alice = await projectActor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const graph = emptyGraph()
    graph.nodes.push(nodeRecord('n_vid', 'video'))
    await writeGraph(flowId, graph)
    const id = await orphan(flowId, alice.userId, VIDEO_APP, 'n_vid', { upstreamId: 'cgt-1' })
    stubAppsConfig()
    vi.stubEnv('TEST_APPS_ARK_KEY', 'ark-key')
    const requests = arkUpstream({ videoRunsFor: 1 })
    await importFreshApp()
    const { replaceAssetStorage } = await import('@shadecn/mod-storage')
    replaceAssetStorage(s3.client)
    // 启动时的对账（1 秒后）接手它
    expect((await taskDone(id)).status).toBe('succeeded')
    expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/contents/generations/tasks'))).toBe(false)
    const node = await until(async () => {
      const found = await storedNode(flowId, 'n_vid')
      return found?.runtime.status === 'completed' ? found : null
    }, '节点被写回')
    expect(node.runtime.taskId).toBe(id)
  })

  it('接手时发起人已不能进这张画布：任务记失败，不续查上游、不碰节点', async () => {
    const alice = await projectActor('alice')
    const bob = await projectActor('bob')
    const flowId = await createFlow(alice, await createProject(alice))
    const graph = emptyGraph()
    graph.nodes.push(nodeRecord('n_vid', 'video'))
    await writeGraph(flowId, graph)
    // bob 不是这个项目的成员（比如提交之后被移出、进程又重启了）
    const id = await orphan(flowId, bob.userId, VIDEO_APP, 'n_vid', { upstreamId: 'cgt-1' })
    stubAppsConfig()
    vi.stubEnv('TEST_APPS_ARK_KEY', 'ark-key')
    const requests = arkUpstream()
    await importFreshApp()
    const row = await taskDone(id)
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('发起人已不能访问这张画布') })
    expect(requests).toHaveLength(0)
    expect((await storedNode(flowId, 'n_vid'))?.runtime).toEqual({ status: 'idle' })
  })

  it('没有句柄却在 running（同步上游调到一半进程没了）：记失败，不重复提交', async () => {
    const alice = await projectActor('alice')
    const flowId = await createFlow(alice, await createProject(alice))
    const id = await orphan(flowId, alice.userId, IMAGE_APP, 'n_img', null)
    stubAppsConfig()
    vi.stubEnv('TEST_APPS_ARK_KEY', 'ark-key')
    const requests = arkUpstream()
    await importFreshApp()
    const row = await taskDone(id)
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('执行中断') })
    expect(requests).toHaveLength(0)
  })
})
