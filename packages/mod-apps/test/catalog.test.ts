import { describe, expect, it } from 'vitest'
import { AppError } from '../src/contract.ts'
import { json, scriptedFetch, serviceOf } from './helpers.ts'

const ark = { type: 'ark', apiKey: '$ARK_KEY', pollIntervalMs: 1 }
const seedream = { provider: 'ark', operation: 'image', model: 'seedream' }

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
  it('形状不对是启动错误：不认识的字段、没有的驱动、没有的提供方 / 操作', () => {
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, oops: 1 } } })).toThrow(/不认识的字段 oops/)
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, model: 'm', options: { typo: 1 } } } })).toThrow(
      /options：不认识的字段 typo/,
    )
    expect(() => serviceOf({ providers: { x: { type: 'nope' } } })).toThrow(/type 必须是 ark \/ comfyui \/ ollama/)
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, provider: 'other' } } })).toThrow(/provider other 不在/)
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, operation: 'music' } } })).toThrow(/没有操作 music/)
    expect(() => serviceOf({ extra: {} })).toThrow(/不认识的字段 extra/)
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
    const service = serviceOf({ providers: { ark }, apps: { a: seedream } })
    expect(service.get('a')?.unavailable).toMatch(/ARK_KEY 没有设置/)
    expect((await failure(service.executeApp('a', { prompt: 'x' }))).code).toBe('unavailable')
  })

  it('defaults 里写了不是参数的项、或类型不对 → 启动错误', () => {
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, defaults: { colour: 'red' } } } })).toThrow(/colour 不是这个应用的参数/)
    expect(() => serviceOf({ providers: { ark }, apps: { a: { ...seedream, defaults: { watermark: 'no' } } } })).toThrow(/watermark 必须是/)
  })

  it('列表里只有给调用方看的信息，defaults 合进参数表', () => {
    const service = serviceOf(
      { providers: { ark }, apps: { a: { ...seedream, title: '文生图', defaults: { size: '2K' } } } },
      { env: { ARK_KEY: 'k' } },
    )
    const [app] = service.list()
    expect(app).toMatchObject({ id: 'a', title: '文生图', category: 'image', driver: 'ark' })
    expect(app!.params.size!.default).toBe('2K')
    expect(JSON.stringify(app)).not.toContain('ARK_KEY')
  })
})

describe('executeApp', () => {
  const env = { ARK_KEY: 'k' }

  it('没有的应用 → not_found；参数不对一次全报 → invalid_params', async () => {
    const service = serviceOf({ providers: { ark }, apps: { a: seedream } }, { env })
    expect((await failure(service.executeApp('zzz', {}))).code).toBe('not_found')
    const error = await failure(service.executeApp('a', { size: 3, colour: 'red' }))
    expect(error.code).toBe('invalid_params')
    expect(error.detail).toEqual(expect.arrayContaining([expect.stringMatching(/colour/), '缺少参数 prompt', expect.stringMatching(/size 必须是字符串/)]))
  })

  it('超过应用的 timeoutMs → timeout；调用方中止 → aborted', async () => {
    const hang = (async (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const service = serviceOf({ providers: { ark }, apps: { a: { ...seedream, timeoutMs: 20 } } }, { env, fetch: hang })
    expect((await failure(service.executeApp('a', { prompt: 'x' }))).code).toBe('timeout')

    const slow = serviceOf({ providers: { ark }, apps: { a: seedream } }, { env, fetch: hang })
    const controller = new AbortController()
    const pending = failure(slow.executeApp('a', { prompt: 'x' }, { signal: controller.signal }))
    controller.abort()
    expect((await pending).code).toBe('aborted')
  })

  it('上游非 2xx → upstream，消息里挑出上游的那句话', async () => {
    const upstream = scriptedFetch({ 'POST /api/v3/images': () => json({ error: { code: 'InvalidParameter', message: 'size 不支持' } }, 400) })
    const service = serviceOf({ providers: { ark }, apps: { a: seedream } }, { env, fetch: upstream.fetch })
    const error = await failure(service.executeApp('a', { prompt: 'x' }))
    expect(error.code).toBe('upstream')
    expect(error.message).toContain('400：size 不支持')
  })
})
