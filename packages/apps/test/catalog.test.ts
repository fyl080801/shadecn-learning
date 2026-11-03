import { describe, expect, it } from 'vitest'
import { AppError } from '../src/contract.js'
import { json, scriptedFetch, serviceOf } from './service-helpers.js'

const ark = { type: 'ark', apiKey: '$ARK_KEY', pollIntervalMs: 1 }
const seedream = { provider: 'ark', type: 'image', model: 'seedream' }
const APP = 'ark:seedream'

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof AppError) return err
    throw err
  }
  throw new Error('没有失败')
}

describe('应用表', () => {
  it('形状不对是启动错误：不认识的字段、没有的驱动、没有的提供方 / 类别，报错带位置', () => {
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, oops: 1 }] })).toThrow(/modules\.apps\.apps\[0\]：不认识的字段 oops/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, options: { typo: 1 } }] })).toThrow(/modules\.apps\.apps\[0\]\.options：不认识的字段 typo/)
    expect(() => serviceOf({ providers: { x: { type: 'nope' } } })).toThrow(/modules\.apps\.providers\.x：type 必须是 ark \/ comfyui \/ ollama/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, provider: 'other' }] })).toThrow(/provider other 不在/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, type: 'music' }] })).toThrow(/type 只能是 text \/ image/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, type: 'text' }] })).toThrow(/ark 不能做 type text（只有 image \/ video \/ 3d）/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ provider: 'ark', model: 'm' }] })).toThrow(/缺少 type/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ type: 'image', model: 'm' }] })).toThrow(/缺少 provider/)
    expect(() => serviceOf({ extra: {} })).toThrow(/不认识的字段 extra/)
  })

  it('apps 是数组，元素是对象；按名字写的旧形状 / 旧字段 operation 启动失败', () => {
    expect(() => serviceOf({ providers: { ark }, apps: { seedream } })).toThrow(/modules\.apps\.apps 必须是数组/)
    expect(() => serviceOf({ providers: { ark }, apps: ['seedream'] })).toThrow(/modules\.apps\.apps\[0\]：必须是对象/)
    expect(() => serviceOf({ providers: { ark }, apps: [null] })).toThrow(/modules\.apps\.apps\[0\]：必须是对象/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, operation: 'image' }] })).toThrow(/不认识的字段 operation/)
    expect(() => serviceOf({ providers: 'ark' })).toThrow(/providers 必须是对象/)
  })

  it('没有 apps = 空表，不是错误', () => {
    expect(serviceOf({}).list()).toEqual([])
    expect(serviceOf({ providers: { ark }, apps: null }).list()).toEqual([])
  })

  it('应用 id 自动生成：<provider>:<model>，model 里的字符不校验', () => {
    const service = serviceOf({ providers: { ark }, apps: [seedream, { ...seedream, model: 'a/b:c.d' }] }, { env: { ARK_KEY: 'k' } })
    expect(service.list().map((app) => app.id)).toEqual(['ark:seedream', 'ark:a/b:c.d'])
    expect(service.get('ark:a/b:c.d')!.model).toBe('a/b:c.d')
  })

  it('一项一个模型：model 写数组是启动错误，提示每个模型写一项；要 model 的操作写 id、缺 model 都是启动错误', () => {
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, model: ['a', 'b'] }] })).toThrow(/modules\.apps\.apps\[0\]：model 只能是一个模型 id，每个模型写一项/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, model: 3 }] })).toThrow(/model 必须是字符串/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ provider: 'ark', type: 'image' }] })).toThrow(/缺少 model/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, id: 'mine' }] })).toThrow(/不要写 id/)
  })

  it('同一个提供方的同一个模型写两项 → 启动错误，说清楚和哪一项重复；换个提供方就不重复', () => {
    expect(() => serviceOf({ providers: { ark }, apps: [seedream, { ...seedream, title: '又一个' }] })).toThrow(/modules\.apps\.apps\[1\]：应用 ark:seedream 和 apps\[0\] 重复/)
    const service = serviceOf({ providers: { ark, other: ark }, apps: [seedream, { ...seedream, provider: 'other' }] })
    expect(service.list().map((app) => app.id)).toEqual(['ark:seedream', 'other:seedream'])
  })

  it('标题：条目 title → model', () => {
    const service = serviceOf({ providers: { ark }, apps: [{ ...seedream, title: '文生图' }, { ...seedream, model: 'no-title' }] })
    expect(service.get(APP)!.title).toBe('文生图')
    expect(service.get('ark:no-title')!.title).toBe('no-title')
  })

  it('密钥只认 $ENV：明文是启动错误，且报错里不带原值', () => {
    expect(() => serviceOf({ providers: { ark: { ...ark, apiKey: 'sk-plain' } } })).toThrow(/只能写成 "\$环境变量名"/)
    try {
      serviceOf({ providers: { ark: { ...ark, apiKey: 'sk-plain' } } })
    } catch (err) {
      expect(String(err)).not.toContain('sk-plain')
    }
  })

  it('环境变量没设 → 应用不可用（不是启动错误），执行回 unavailable', async () => {
    const service = serviceOf({ providers: { ark }, apps: [seedream] })
    expect(service.get(APP)?.unavailable).toMatch(/ARK_KEY 没有设置/)
    expect((await failure(service.executeApp(APP, { prompt: 'x' }))).code).toBe('unavailable')
  })

  it('defaults 里写了不是参数的项、或类型不对 → 启动错误', () => {
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, defaults: { colour: 'red' } }] })).toThrow(/colour 不是这个应用的参数/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, defaults: { watermark: 'no' } }] })).toThrow(/watermark 必须是/)
    expect(() => serviceOf({ providers: { ark }, apps: [{ ...seedream, defaults: { model: 'x' } }] })).toThrow(/model 不是这个应用的参数/)
  })

  it('列表里只有给调用方看的信息，defaults 合进参数表，带上模型', () => {
    const service = serviceOf(
      { providers: { ark }, apps: [{ ...seedream, title: '文生图', defaults: { size: '2K' } }] },
      { env: { ARK_KEY: 'k' } },
    )
    const [app] = service.list()
    expect(app).toMatchObject({ id: APP, title: '文生图', category: 'image', driver: 'ark', model: 'seedream' })
    expect(app!.params.size!.default).toBe('2K')
    expect(JSON.stringify(app)).not.toContain('ARK_KEY')
  })
})

describe('executeApp', () => {
  const env = { ARK_KEY: 'k' }

  it('没有的应用 → not_found；参数不对一次全报 → invalid_params', async () => {
    const service = serviceOf({ providers: { ark }, apps: [seedream] }, { env })
    expect((await failure(service.executeApp('zzz', {}))).code).toBe('not_found')
    const error = await failure(service.executeApp(APP, { size: 3, colour: 'red' }))
    expect(error.code).toBe('invalid_params')
    expect(error.detail).toEqual(expect.arrayContaining([expect.stringMatching(/colour/), '缺少参数 prompt', expect.stringMatching(/size 必须是字符串/)]))
  })

  it('超过条目的 timeoutMs → timeout；调用方中止 → aborted', async () => {
    const hang = (async (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const service = serviceOf({ providers: { ark }, apps: [{ ...seedream, timeoutMs: 20 }] }, { env, fetch: hang })
    expect((await failure(service.executeApp(APP, { prompt: 'x' }))).code).toBe('timeout')

    const slow = serviceOf({ providers: { ark }, apps: [seedream] }, { env, fetch: hang })
    const controller = new AbortController()
    const pending = failure(slow.executeApp(APP, { prompt: 'x' }, { signal: controller.signal }))
    controller.abort()
    expect((await pending).code).toBe('aborted')
  })

  it('上游非 2xx → upstream，消息里挑出上游的那句话', async () => {
    const upstream = scriptedFetch({ 'POST /api/v3/images': () => json({ error: { code: 'InvalidParameter', message: 'size 不支持' } }, 400) })
    const service = serviceOf({ providers: { ark }, apps: [seedream] }, { env, fetch: upstream.fetch })
    const error = await failure(service.executeApp(APP, { prompt: 'x' }))
    expect(error.code).toBe('upstream')
    expect(error.message).toContain('400：size 不支持')
  })
})

describe('不要模型的操作（ComfyUI）写 id', () => {
  const providers = { comfy: { type: 'comfyui' } }
  // 工作流文件读不到是 prepare 的错误：这几条在读工作流之前就该报
  const base = { provider: 'comfy', type: 'image', options: { workflow: 'missing.json' } }

  it('写了 model、缺 id、id 不合法 → 启动错误', () => {
    expect(() => serviceOf({ providers, apps: [{ ...base, model: 'm' }] })).toThrow(/不用 model/)
    expect(() => serviceOf({ providers, apps: [base] })).toThrow(/缺少 id/)
    expect(() => serviceOf({ providers, apps: [{ ...base, id: 'Bad:Id' }] })).toThrow(/id 不合法/)
    expect(() => serviceOf({ providers, apps: [{ ...base, id: 'sdxl' }] })).toThrow(/读不到工作流/)
  })
})
