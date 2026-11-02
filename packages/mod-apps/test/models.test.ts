import { fileURLToPath } from 'node:url'
import { parseConfigFile } from '@shadecn/server-kit/config'
import { describe, expect, it } from 'vitest'
import { buildCatalog, createAppsService } from '../src/catalog.ts'
import { defineDriver, type AnyProviderDriver } from '../src/driver.ts'
import { json, scriptedFetch, serviceOf } from './helpers.ts'

/**
 * 一项一个模型（docs/29 §3.7）：参数表 = 驱动的基础表 → 条目的 `params`。
 * 5.0 pro 的条目用 `sample/server.config.example.yaml` 里的那份（和发布出去的示例是同一份数据）。
 */
const PRO = 'doubao-seedream-5-0-pro-260628'
const V45 = 'doubao-seedream-4-5-251128'
const sample = parseConfigFile(fileURLToPath(new URL('../../../sample/server.config.example.yaml', import.meta.url))) as {
  modules: { apps: { apps: { model?: string }[] } }
}
const proEntry = sample.modules.apps.apps.find((entry) => entry.model === PRO)!

const providers = { ark: { type: 'ark', apiKey: '$ARK_KEY', pollIntervalMs: 1 } }
const env = { ARK_KEY: 'k' }
const bare = (model: string, extra: Record<string, unknown> = {}) => ({ provider: 'ark', type: 'image', model, ...extra })
const ID = { pro: `ark:${PRO}`, v45: `ark:${V45}` }

function imageUpstream() {
  return scriptedFetch({ 'POST /api/v3/images/generations': () => json({ data: [{ url: 'https://ark/1.png' }] }) })
}

describe('条目的 params', () => {
  it('收窄驱动的基础表：null 去掉参数、部分覆盖；没写 params 的用基础表（各代的并集）', () => {
    const service = serviceOf({ providers, apps: [proEntry, bare(V45)] }, { env })
    const pro = service.get(ID.pro)!
    expect(pro).toMatchObject({ title: 'Seedream 5.0 pro', model: PRO })
    expect(pro.params.image!.maxLength).toBe(10)
    expect(pro.params.maxImages).toBeUndefined()
    const base = service.get(ID.v45)!
    expect(base.params.image!.maxLength).toBe(14)
    expect(base.params.maxImages).toBeDefined()
    expect(base.params.outputFormat).toBeDefined()
    expect(base.title).toBe(V45)
  })

  it('按这一项的参数表校验：5.0 不收 maxImages、11 张参考图超限，都不发请求；基础表就收', async () => {
    const upstream = imageUpstream()
    const service = serviceOf({ providers, apps: [proEntry, bare(V45)] }, { env, fetch: upstream.fetch })
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a/${i}.png`)
    await expect(service.executeApp(ID.pro, { prompt: 'x', maxImages: 2 })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('不认识的参数 maxImages') })
    await expect(service.executeApp(ID.pro, { prompt: 'x', image: eleven })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('最多 10 张') })
    expect(() => service.validate(ID.pro, { prompt: 'x', maxImages: 2 })).toThrow(/不认识的参数 maxImages/)
    expect(upstream.requests).toHaveLength(0)

    await service.executeApp(ID.v45, { prompt: 'x', maxImages: 2, image: eleven })
    expect(upstream.requests[0]!.body).toMatchObject({ model: V45, sequential_image_generation: 'auto' })
  })

  it('model 不是参数：传了算不认识的参数（执行和校验都是），列表的参数表里也没有；请求用条目上的模型', async () => {
    const upstream = imageUpstream()
    const service = serviceOf({ providers, apps: [bare(PRO)] }, { env, fetch: upstream.fetch })
    await expect(service.executeApp(ID.pro, { model: V45, prompt: 'x' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('不认识的参数 model') })
    expect(() => service.validate(ID.pro, { model: V45, prompt: 'x' })).toThrow(/不认识的参数 model/)
    expect(service.get(ID.pro)!.params.model).toBeUndefined()
    expect(service.validate(ID.pro, { prompt: 'x' })).toEqual({ model: PRO })
    await service.executeApp(ID.pro, { prompt: 'x' })
    expect(upstream.requests[0]!.body).toMatchObject({ model: PRO })
  })

  it('params 能加新参数（要写 type）、改默认值、整个替换 enum', () => {
    const service = serviceOf(
      {
        providers,
        apps: [
          bare('next', {
            title: '9.0',
            params: {
              maxImages: null,
              size: { default: '4K' },
              outputFormat: { enum: ['png'] },
              style: { type: 'string', enum: ['a', 'b'] },
            },
          }),
        ],
      },
      { env },
    )
    const { params } = service.get('ark:next')!
    expect(params.maxImages).toBeUndefined()
    expect(params.size!.default).toBe('4K')
    expect(params.outputFormat!.enum).toEqual(['png'])
    expect(params.style).toMatchObject({ type: 'string', enum: ['a', 'b'] })
  })

  it('params 写错 → 启动错误：新参数没写 type、不认识的字段、不是对象、加了保留的 model', () => {
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { style: { enum: ['a'] } } })] }, { env })).toThrow(/新加时要写 type/)
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { size: { oops: 1 } } })] }, { env })).toThrow(/不认识的字段 oops/)
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: 'x' })] }, { env })).toThrow(/params：必须是对象/)
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { model: { type: 'string' } } })] }, { env })).toThrow(/params 里不能有 model/)
  })

  it('params 去掉的参数不能再写进 defaults', () => {
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { maxImages: null }, defaults: { maxImages: 3 } })] }, { env })).toThrow(/maxImages 不是这个应用的参数/)
  })

  it('defaults 合进请求，调用方优先', async () => {
    const upstream = imageUpstream()
    const service = serviceOf({ providers, apps: [bare(V45, { defaults: { maxImages: 3 } })] }, { env, fetch: upstream.fetch })
    await service.executeApp(ID.v45, { prompt: 'x' })
    expect(upstream.requests[0]!.body).toMatchObject({ model: V45, sequential_image_generation_options: { max_images: 3 } })
    await service.executeApp(ID.v45, { prompt: 'x', maxImages: 5 })
    expect(upstream.requests[1]!.body).toMatchObject({ sequential_image_generation_options: { max_images: 5 } })
  })

  it('尺寸（size）：档位或范围内的宽x高；超出像素范围、太扁、档位不对 → 发请求前就报错', async () => {
    const upstream = imageUpstream()
    const wide = {
      size: { tiers: ['2K', '4K'], minPixels: 3686400, maxPixels: 16777216 },
    }
    const service = serviceOf({ providers, apps: [proEntry, bare(V45, { params: wide })] }, { env, fetch: upstream.fetch })
    const size = service.get(ID.pro)!.params.size!
    expect(size).toMatchObject({ type: 'size', tiers: ['1K', '1.5K', '2K'], maxPixels: 4624220, maxAspect: 16 })
    expect(size.presets!['16:9']).toEqual(['1424x800', '2048x1152', '2816x1584'])

    await service.executeApp(ID.pro, { prompt: 'x', size: '1.5K' })
    await service.executeApp(ID.pro, { prompt: 'x', size: '2816x1584' })
    // 不在常用表里、但在范围内的宽高照样收
    await service.executeApp(ID.pro, { prompt: 'x', size: '2000x1000' })
    expect(upstream.requests.map((request) => (request.body as { size: string }).size)).toEqual(['1.5K', '2816x1584', '2000x1000'])

    for (const [bad, reason] of [['4K', '只能是'], ['4096x4096', '太大'], ['512x512', '太小'], ['8000x400', '太扁']] as const) {
      await expect(service.executeApp(ID.pro, { prompt: 'x', size: bad })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(reason) })
    }
    // 另一项的范围不同：4K 档、4096x4096 都收，1K 不收
    await service.executeApp(ID.v45, { prompt: 'x', size: '4K' })
    await service.executeApp(ID.v45, { prompt: 'x', size: '4096x4096' })
    await expect(service.executeApp(ID.v45, { prompt: 'x', size: '1024x1024' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('尺寸写错：presets 和 tiers 不一样长、常用表里的宽高超出范围 → 启动错误', () => {
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { size: { tiers: ['1K', '2K'], presets: { '1:1': ['1024x1024'] } } } })] }, { env })).toThrow(/一样长/)
    expect(() => serviceOf({ providers, apps: [bare(PRO, { params: { size: { tiers: ['1K'], maxPixels: 1000000, presets: { '1:1': ['2048x2048'] } } } })] }, { env })).toThrow(/2048x2048 不合法/)
  })
})

describe('驱动协议', () => {
  /** 一个假驱动：`checkModel` 判 bad 开头的模型用不了；参数表可以换 */
  function fakeDriver(params: Record<string, { type: 'string' }> = { prompt: { type: 'string' } }): AnyProviderDriver {
    return defineDriver<null>({
      type: 'fake',
      description: '测试驱动',
      parseProvider: () => null,
      operations: {
        text: {
          description: '回显模型名',
          prepare: () => ({
            params,
            checkModel: (model) => (model.startsWith('bad') ? `${model} 解析不了` : null),
            submit: async (_values, _ctx, model) => ({ done: true, output: { outputs: [{ kind: 'text', text: model! }] } }),
          }),
        },
      },
    })
  }
  const build = (driver: AnyProviderDriver, ...models: string[]) =>
    createAppsService(
      buildCatalog({ providers: { p: { type: 'fake' } }, apps: models.map((model) => ({ provider: 'p', type: 'text', model })) }, 'modules.apps', {
        drivers: [driver],
        env: { envVar: () => undefined, appRoot: '/', llmProviders: {} },
        defaultTimeoutMs: 1000,
      }),
    )

  it('checkModel 的结果进这个应用的 unavailable（不是启动错误），不连累别的应用；选它回 unavailable', async () => {
    const service = build(fakeDriver(), 'bad-1', 'good')
    expect(service.get('p:bad-1')!.unavailable).toBe('模型 bad-1：bad-1 解析不了')
    expect(service.get('p:good')!.unavailable).toBeUndefined()
    expect((await service.executeApp('p:good', {})).outputs[0]!.text).toBe('good')
    await expect(service.executeApp('p:bad-1', {})).rejects.toMatchObject({ code: 'unavailable' })
    expect(() => service.validate('p:bad-1', {})).toThrow(/现在用不了/)
  })

  it('驱动的参数表里不能有保留的 model → 启动错误', () => {
    expect(() => build(fakeDriver({ model: { type: 'string' } }), 'good')).toThrow(/驱动的参数表里不能有 model/)
  })

  it('类别来自操作的键，不是驱动自己报的', () => {
    expect(build(fakeDriver(), 'good').get('p:good')).toMatchObject({ category: 'text', driver: 'fake' })
  })
})
