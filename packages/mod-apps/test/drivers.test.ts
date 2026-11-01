import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { json, scriptedFetch, serviceOf } from './helpers.ts'

describe('火山方舟', () => {
  const providers = { ark: { type: 'ark', apiKey: '$ARK_KEY', pollIntervalMs: 1 } }
  const env = { ARK_KEY: 'secret-key' }

  it('图片：请求体合并 body / 参数，model 不能被 body 盖掉；组图个别失败不影响其余的', async () => {
    const upstream = scriptedFetch({
      'POST /api/v3/images/generations': () =>
        json({ data: [{ url: 'https://ark/1.png', size: '2048x2048' }, { error: { message: '审核未通过' } }], usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } }),
    })
    const service = serviceOf(
      { providers, apps: { img: { provider: 'ark', operation: 'image', model: 'seedream-4', options: { body: { model: 'evil', optimize_prompt_options: { mode: 'fast' } } } } } },
      { env, fetch: upstream.fetch },
    )
    const result = await service.executeApp('img', { prompt: '一只猫', maxImages: 2, image: ['https://a/ref.png'] })
    const request = upstream.requests[0]!
    expect(request.headers.get('authorization')).toBe('Bearer secret-key')
    expect(request.body).toMatchObject({
      model: 'seedream-4',
      prompt: '一只猫',
      image: 'https://a/ref.png',
      watermark: false,
      response_format: 'url',
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 2 },
      optimize_prompt_options: { mode: 'fast' },
    })
    expect(result.outputs).toEqual([{ kind: 'image', url: 'https://ark/1.png', meta: { size: '2048x2048' } }])
    expect(result.usage).toMatchObject({ generatedImages: 1, outputTokens: 16384 })
  })

  it('视频：建任务 → 轮询到 succeeded，产物是 video_url；进度回调每轮报一次', async () => {
    let polls = 0
    const upstream = scriptedFetch({
      'POST /api/v3/contents/generations/tasks': () => json({ id: 'cgt-1' }),
      'GET /api/v3/contents/generations/tasks/cgt-1': () =>
        json(++polls < 3 ? { id: 'cgt-1', status: polls === 1 ? 'queued' : 'running' } : { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://ark/v.mp4' }, usage: { completion_tokens: 10, total_tokens: 10 } }),
    })
    const service = serviceOf({ providers, apps: { vid: { provider: 'ark', operation: 'video', model: 'seedance' } } }, { env, fetch: upstream.fetch })
    const progress: string[] = []
    const result = await service.executeApp('vid', { prompt: '海浪', firstFrame: 'https://a/f.png', duration: 5 }, { onProgress: (p) => progress.push(p.status) })
    expect(upstream.requests[0]!.body).toMatchObject({
      model: 'seedance',
      duration: 5,
      content: [{ type: 'text', text: '海浪' }, { type: 'image_url', image_url: { url: 'https://a/f.png' }, role: 'first_frame' }],
    })
    expect(progress).toEqual(['queued', 'running'])
    expect(result).toMatchObject({ upstreamId: 'cgt-1', outputs: [{ kind: 'video', url: 'https://ark/v.mp4' }], usage: { outputTokens: 10 } })
  })

  it('视频：任务 failed → upstream 带上上游原因；首尾帧规则在发请求之前就挡掉', async () => {
    const upstream = scriptedFetch({
      'POST /api/v3/contents/generations/tasks': () => json({ id: 'cgt-2' }),
      'GET /api/v3/contents/generations/tasks/cgt-2': () => json({ status: 'failed', error: { message: '输入图片不合规' } }),
    })
    const service = serviceOf({ providers, apps: { vid: { provider: 'ark', operation: 'video', model: 'm' } } }, { env, fetch: upstream.fetch })
    await expect(service.executeApp('vid', { prompt: 'x' })).rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('输入图片不合规') })
    const before = upstream.requests.length
    await expect(service.executeApp('vid', { lastFrame: 'https://a/l.png' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(upstream.requests.length).toBe(before)
  })

  it('视频：建好任务就交出续查句柄；拿句柄续查不重新建任务，时限从开始算；取消 = DELETE 任务', async () => {
    let polls = 0
    const upstream = scriptedFetch({
      'POST /api/v3/contents/generations/tasks': () => json({ id: 'cgt-9' }),
      'GET /api/v3/contents/generations/tasks/cgt-9': () =>
        json(++polls < 2 ? { status: 'running' } : { status: 'succeeded', content: { video_url: 'https://ark/v.mp4' } }),
      'DELETE /api/v3/contents/generations/tasks/cgt-9': () => new Response(null, { status: 200 }),
    })
    const service = serviceOf({ providers, apps: { vid: { provider: 'ark', operation: 'video', model: 'm' } } }, { env, fetch: upstream.fetch })
    const handles: unknown[] = []
    await service.executeApp('vid', { prompt: '海浪' }, { onSubmitted: (handle) => void handles.push(handle) })
    expect(handles).toEqual([{ upstreamId: 'cgt-9' }])

    polls = 0
    const created = upstream.requests.filter((request) => request.method === 'POST').length
    const resumed = await service.resumeApp('vid', { upstreamId: 'cgt-9' })
    expect(resumed).toMatchObject({ upstreamId: 'cgt-9', outputs: [{ kind: 'video', url: 'https://ark/v.mp4' }] })
    expect(upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(created)

    // 开始得太早（超过应用时限）：续查直接 timeout
    await expect(service.resumeApp('vid', { upstreamId: 'cgt-9' }, { startedAt: Date.now() - 60 * 60_000 })).rejects.toMatchObject({ code: 'timeout' })

    await service.cancelUpstream('vid', { upstreamId: 'cgt-9' })
    expect(upstream.requests.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/tasks/cgt-9') })
  })

  it('取消失败只打日志、不抛；3D 的输出格式存在句柄里，续查也带得出来', async () => {
    const upstream = scriptedFetch({
      'GET /api/v3/contents/generations/tasks/cgt-3': () => json({ status: 'succeeded', content: { file_url: 'https://ark/m.zip' } }),
      'DELETE /api/v3/contents/generations/tasks/cgt-3': () => json({ error: { message: '运行中的任务不能删除' } }, 400),
    })
    const service = serviceOf({ providers, apps: { mesh: { provider: 'ark', operation: '3d', model: 'seed3d' } } }, { env, fetch: upstream.fetch })
    await expect(service.cancelUpstream('mesh', { upstreamId: 'cgt-3' })).resolves.toBeUndefined()
    const result = await service.resumeApp('mesh', { upstreamId: 'cgt-3', state: { fileFormat: 'obj' } })
    expect(result.outputs[0]).toMatchObject({ meta: { fileFormat: 'obj' } })
  })

  it('3D：图片进 content，产物是 file_url 的 zip', async () => {
    const upstream = scriptedFetch({
      'POST /api/v3/contents/generations/tasks': () => json({ id: 'cgt-3' }),
      'GET /api/v3/contents/generations/tasks/cgt-3': () => json({ status: 'succeeded', content: { file_url: 'https://ark/m.zip' } }),
    })
    const service = serviceOf({ providers, apps: { mesh: { provider: 'ark', operation: '3d', model: 'seed3d' } } }, { env, fetch: upstream.fetch })
    const result = await service.executeApp('mesh', { image: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(upstream.requests[0]!.body).toMatchObject({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }], file_format: 'glb' })
    expect(result.outputs[0]).toMatchObject({ kind: '3d', url: 'https://ark/m.zip', mimeType: 'application/zip' })
  })
})

describe('ComfyUI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mod-apps-'))
  writeFileSync(
    path.join(dir, 'wf.json'),
    JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '10': { class_type: 'LoadImage', inputs: { image: '' } },
      '9': { class_type: 'SaveImage', inputs: {} },
    }),
  )
  const app = {
    provider: 'comfy',
    operation: 'workflow',
    options: {
      workflow: 'wf.json',
      category: 'image',
      inputs: {
        prompt: { node: '6', field: 'text', type: 'string', required: true },
        seed: { node: '3', field: 'seed', type: 'integer', random: true },
        image: { node: '10', field: 'image', type: 'image' },
      },
    },
  }
  const providers = { comfy: { type: 'comfyui', baseUrl: 'http://comfy:8188', pollIntervalMs: 1 } }

  it('参数填进节点、随机种子、图片先上传；轮询 history，产物按文件名取字节', async () => {
    let polls = 0
    const upstream = scriptedFetch({
      'POST /upload/image': () => json({ name: 'up.png', subfolder: 'in' }),
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () =>
        json(
          ++polls < 2
            ? {}
            : {
                p1: {
                  status: { status_str: 'success', completed: true },
                  outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }, { filename: 'pre.png', type: 'temp' }] } },
                },
              },
        ),
      'GET /view': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    })
    const service = serviceOf({ providers, apps: { sd: app } }, { fetch: upstream.fetch, appRoot: dir })
    expect(Object.keys(service.get('sd')!.params)).toEqual(['prompt', 'seed', 'image'])
    const result = await service.executeApp('sd', { prompt: '猫', image: 'data:image/png;base64,iVBORw0KGgo=' })

    const submitted = upstream.requests.find((r) => r.url.endsWith('/prompt'))!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }
    expect(submitted.prompt['6']!.inputs.text).toBe('猫')
    expect(submitted.prompt['10']!.inputs.image).toBe('in/up.png')
    expect(typeof submitted.prompt['3']!.inputs.seed).toBe('number')
    expect(submitted.prompt['3']!.inputs.steps).toBe(20)
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]), meta: { node: '9', filename: 'out.png' } })
  })

  it('续查句柄是 prompt_id；取消 = 从队列删掉 + 打断这个 prompt', async () => {
    const upstream = scriptedFetch({
      'POST /prompt': () => json({ prompt_id: 'p-7' }),
      'GET /history/p-7': () => json({}),
      'POST /queue': () => json({}),
      'POST /interrupt': () => new Response('', { status: 200 }),
    })
    const service = serviceOf({ providers, apps: { sdxl: app } }, { appRoot: dir, fetch: upstream.fetch, defaultTimeoutMs: 50 })
    const handles: unknown[] = []
    await expect(service.executeApp('sdxl', { prompt: 'x' }, { onSubmitted: (handle) => void handles.push(handle) })).rejects.toMatchObject({ code: 'timeout' })
    expect(handles).toEqual([{ upstreamId: 'p-7' }])
    await service.cancelUpstream('sdxl', { upstreamId: 'p-7' })
    expect(upstream.requests.slice(-2).map((request) => [request.url, request.body])).toEqual([
      ['http://comfy:8188/queue', { delete: ['p-7'] }],
      ['http://comfy:8188/interrupt', { prompt_id: 'p-7' }],
    ])
  })

  it('图片参数给外部地址 → invalid_params，不替调用方去抓', async () => {
    const upstream = scriptedFetch({})
    const service = serviceOf({ providers, apps: { sd: app } }, { fetch: upstream.fetch, appRoot: dir })
    await expect(service.executeApp('sd', { prompt: 'x', image: 'http://169.254.169.254/a.png' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(upstream.requests).toHaveLength(0)
  })

  it('执行出错 → upstream 带上 ComfyUI 的异常信息；映射到不存在的节点是启动错误', async () => {
    const upstream = scriptedFetch({
      'POST /prompt': () => json({ prompt_id: 'p2' }),
      'GET /history/p2': () => json({ p2: { status: { status_str: 'error', messages: [['execution_error', { exception_message: '显存不足' }]] } } }),
    })
    const service = serviceOf({ providers, apps: { sd: app } }, { fetch: upstream.fetch, appRoot: dir })
    await expect(service.executeApp('sd', { prompt: 'x' })).rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('显存不足') })
    const broken = { ...app, options: { ...app.options, inputs: { prompt: { node: '99', field: 'text' } } } }
    expect(() => serviceOf({ providers, apps: { sd: broken } }, { appRoot: dir })).toThrow(/没有节点 99/)
  })
})

describe('ollama', () => {
  function sse(...chunks: unknown[]) {
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }

  it('走 agent 的 ollama 预设：本机 /v1、占位 key、老式 Chat Completions；回文字和用量', async () => {
    const upstream = scriptedFetch({
      'POST /v1/chat/completions': () =>
        sse(
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] },
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ),
    })
    const service = serviceOf(
      { providers: { local: { type: 'ollama' } }, apps: { chat: { provider: 'local', operation: 'chat', model: 'qwen3', options: { system: '你是助手' } } } },
      { fetch: upstream.fetch },
    )
    expect(service.get('chat')).toMatchObject({ category: 'text', driver: 'ollama' })
    // 应用表里写死了 system，就不再把 system 当参数
    expect(Object.keys(service.get('chat')!.params)).toEqual(['prompt', 'temperature'])
    const result = await service.executeApp('chat', { prompt: '嗨' })
    const request = upstream.requests[0]!
    expect(request.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(request.body).toMatchObject({
      model: 'qwen3',
      messages: [{ role: 'system', content: '你是助手' }, { role: 'user' }],
    })
    expect(JSON.stringify(request.body)).not.toContain('developer')
    expect(result.outputs).toEqual([{ kind: 'text', text: '你好', mimeType: 'text/plain' }])
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 })
  })
})
