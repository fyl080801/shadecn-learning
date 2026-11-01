import { fileURLToPath } from 'node:url'
import { parseConfigFile } from '@shadecn/server-kit/config'
import { describe, expect, it } from 'vitest'
import { buildCatalog, createAppsService } from '../src/catalog.ts'
import { defineDriver } from '../src/driver.ts'
import { json, scriptedFetch, serviceOf } from './helpers.ts'

/**
 * 一个应用多个模型（docs/29 §3.7）：参数表 = 驱动的基础表 → 应用表顶层 `models` 的模型档案 → 应用里的 `models.<id>` 覆盖。
 * 模型档案用仓库根 `apps.example.yaml` 里的那份（和发布出去的示例是同一份数据）。
 */
const PROFILES = (parseConfigFile(fileURLToPath(new URL('../../../apps.example.yaml', import.meta.url))) as { models: unknown }).models

const providers = { ark: { type: 'ark', apiKey: '$ARK_KEY', pollIntervalMs: 1 } }
const env = { ARK_KEY: 'k' }
const PRO = 'doubao-seedream-5-0-pro-260628'
const V45 = 'doubao-seedream-4-5-251128'

function imageUpstream() {
  return scriptedFetch({ 'POST /api/v3/images/generations': () => json({ data: [{ url: 'https://ark/1.png' }] }) })
}

describe('模型档案', () => {
  it('多模型：参数表多一个 model（enum = 模型列表，default = 第一个），每个模型各有自己的参数表', () => {
    const service = serviceOf({ models: PROFILES, providers, apps: { img: { provider: 'ark', operation: 'image', model: [PRO, V45] } } }, { env })
    const app = service.get('img')!
    expect(app.defaultModel).toBe(PRO)
    expect(app.params.model).toMatchObject({ type: 'string', enum: [PRO, V45], default: PRO })
    const [pro, v45] = app.models
    // 5.0 pro：参考图最多 10 张、没有组图
    expect(pro).toMatchObject({ id: PRO, title: 'Seedream 5.0' })
    expect(pro!.params.image!.maxLength).toBe(10)
    expect(pro!.params.maxImages).toBeUndefined()
    // 4.5：14 张、有组图、没有 outputFormat
    expect(v45).toMatchObject({ id: V45, title: 'Seedream 4.5' })
    expect(v45!.params.image!.maxLength).toBe(14)
    expect(v45!.params.maxImages).toBeDefined()
    expect(v45!.params.outputFormat).toBeUndefined()
  })

  it('按选中的模型校验：5.0 不收 maxImages、11 张参考图超限；换成 4.5 就收', async () => {
    const upstream = imageUpstream()
    const service = serviceOf({ models: PROFILES, providers, apps: { img: { provider: 'ark', operation: 'image', model: [PRO, V45] } } }, { env, fetch: upstream.fetch })
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a/${i}.png`)
    await expect(service.executeApp('img', { prompt: 'x', maxImages: 2 })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('不认识的参数 maxImages') })
    await expect(service.executeApp('img', { prompt: 'x', image: eleven })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('最多 10 张') })
    expect(upstream.requests).toHaveLength(0)

    await service.executeApp('img', { model: V45, prompt: 'x', maxImages: 2, image: eleven })
    expect(upstream.requests[0]!.body).toMatchObject({ model: V45, sequential_image_generation: 'auto' })
  })

  it('model 不在列表里 → invalid_params；单模型的应用传 model 算不认识的参数', async () => {
    const service = serviceOf(
      { models: PROFILES, providers, apps: { multi: { provider: 'ark', operation: 'image', model: [PRO, V45] }, single: { provider: 'ark', operation: 'image', model: PRO } } },
      { env, fetch: imageUpstream().fetch },
    )
    await expect(service.executeApp('multi', { model: 'nope', prompt: 'x' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(service.executeApp('single', { model: PRO, prompt: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('不认识的参数 model') })
    expect(service.get('single')!.params.model).toBeUndefined()
  })

  it('不认识的新模型用基础表；应用表的 models.<id> 补它的标题和参数差异（null = 去掉，新参数要写 type）', async () => {
    const upstream = imageUpstream()
    const service = serviceOf(
      {
        models: PROFILES,
        providers,
        apps: {
          img: {
            provider: 'ark',
            operation: 'image',
            model: ['doubao-seedream-9-0-x', PRO],
            models: {
              'doubao-seedream-9-0-x': { title: '9.0', params: { maxImages: null, size: { default: '4K' }, style: { type: 'string', enum: ['a', 'b'] } } },
              [PRO]: { params: { size: { tiers: ['1K', '2K'], presets: { '1:1': ['1024x1024', '2048x2048'] } } } },
            },
          },
        },
      },
      { env, fetch: upstream.fetch },
    )
    const [next, pro] = service.get('img')!.models
    expect(next).toMatchObject({ id: 'doubao-seedream-9-0-x', title: '9.0' })
    expect(next!.params.maxImages).toBeUndefined()
    expect(next!.params.size!.default).toBe('4K')
    expect(next!.params.style).toMatchObject({ type: 'string', enum: ['a', 'b'] })
    // 覆盖叠在驱动档案之上：5.0 的 10 张上限还在
    expect(pro!.params.size!.tiers).toEqual(['1K', '2K'])
    expect(pro!.params.image!.maxLength).toBe(10)
    await expect(service.executeApp('img', { model: PRO, prompt: 'x', size: '4K' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('没有模型档案：用驱动的基础表（各代的并集）', () => {
    const service = serviceOf({ providers, apps: { img: { provider: 'ark', operation: 'image', model: PRO } } }, { env })
    expect(service.get('img')!.models[0]!.params.image!.maxLength).toBe(14)
    expect(service.get('img')!.models[0]!.params.maxImages).toBeDefined()
  })

  it('模型档案按文件顺序取第一条匹配的；key 里的 * 只能在最后', () => {
    const lite = 'doubao-seedream-5-0-lite-260101'
    const service = serviceOf({ models: PROFILES, providers, apps: { img: { provider: 'ark', operation: 'image', model: [lite, PRO] } } }, { env })
    const [liteInfo, proInfo] = service.get('img')!.models
    expect(liteInfo).toMatchObject({ title: 'Seedream 5.0 lite' })
    expect(liteInfo!.params.maxImages).toBeDefined()
    expect(proInfo).toMatchObject({ title: 'Seedream 5.0' })
    expect(() => serviceOf({ models: { 'a*b': {} } })).toThrow(/\* 只能在最后/)
    expect(() => serviceOf({ models: { 'a*': { oops: 1 } } })).toThrow(/不认识的字段 oops/)
  })

  it('尺寸（size）：档位或范围内的宽x高；超出像素范围、太扁、档位不对 → 发请求前就报错', async () => {
    const upstream = imageUpstream()
    const service = serviceOf({ models: PROFILES, providers, apps: { img: { provider: 'ark', operation: 'image', model: [PRO, V45] } } }, { env, fetch: upstream.fetch })
    const size = service.get('img')!.models[0]!.params.size!
    expect(size).toMatchObject({ type: 'size', tiers: ['1K', '1.5K', '2K'], maxPixels: 4624220, maxAspect: 16 })
    expect(size.presets!['16:9']).toEqual(['1424x800', '2048x1152', '2816x1584'])

    await service.executeApp('img', { prompt: 'x', size: '1.5K' })
    await service.executeApp('img', { prompt: 'x', size: '2816x1584' })
    // 不在常用表里、但在范围内的宽高照样收
    await service.executeApp('img', { prompt: 'x', size: '2000x1000' })
    expect(upstream.requests.map((request) => (request.body as { size: string }).size)).toEqual(['1.5K', '2816x1584', '2000x1000'])

    for (const [bad, reason] of [['4K', '只能是'], ['4096x4096', '太大'], ['512x512', '太小'], ['8000x400', '太扁']] as const) {
      await expect(service.executeApp('img', { prompt: 'x', size: bad })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(reason) })
    }
    // 4.5 的范围不同：4K 档、4096x4096 都收，1K 不收
    await service.executeApp('img', { model: V45, prompt: 'x', size: '4K' })
    await service.executeApp('img', { model: V45, prompt: 'x', size: '4096x4096' })
    await expect(service.executeApp('img', { model: V45, prompt: 'x', size: '1024x1024' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('尺寸档案写错：presets 和 tiers 不一样长、常用表里的宽高超出范围 → 启动错误', () => {
    const app = { img: { provider: 'ark', operation: 'image', model: PRO } }
    expect(() => serviceOf({ models: { [PRO]: { params: { size: { tiers: ['1K', '2K'], presets: { '1:1': ['1024x1024'] } } } } }, providers, apps: app }, { env })).toThrow(/一样长/)
    expect(() =>
      serviceOf({ models: { [PRO]: { params: { size: { tiers: ['1K'], maxPixels: 1000000, presets: { '1:1': ['2048x2048'] } } } } }, providers, apps: app }, { env }),
    ).toThrow(/2048x2048 不合法/)
  })

  it('应用表写错：models 里的模型不在列表、新参数没写 type、defaults.model 不在列表、不要模型的操作写了 model → 启动错误', () => {
    const base = { provider: 'ark', operation: 'image', model: [PRO] }
    expect(() => serviceOf({ models: PROFILES, providers, apps: { a: { ...base, models: { other: {} } } } }, { env })).toThrow(/other 不在 model 列表里/)
    expect(() => serviceOf({ models: PROFILES, providers, apps: { a: { ...base, models: { [PRO]: { params: { style: { enum: ['a'] } } } } } } }, { env })).toThrow(/新加时要写 type/)
    expect(() => serviceOf({ models: PROFILES, providers, apps: { a: { ...base, defaults: { model: 'x' } } } }, { env })).toThrow(/defaults.model/)
    expect(() => serviceOf({ models: PROFILES, providers, apps: { a: { provider: 'ark', operation: 'image' } } }, { env })).toThrow(/缺少 model/)
    expect(() => serviceOf({ models: PROFILES, providers, apps: { a: { ...base, model: [PRO, PRO] } } }, { env })).toThrow(/写了两次/)
  })

  it('defaults 只对有这个参数的模型生效；defaults.model 换默认模型', async () => {
    const upstream = imageUpstream()
    const service = serviceOf(
      { models: PROFILES, providers, apps: { img: { provider: 'ark', operation: 'image', model: [PRO, V45], defaults: { model: V45, maxImages: 3 } } } },
      { env, fetch: upstream.fetch },
    )
    expect(service.get('img')!.defaultModel).toBe(V45)
    await service.executeApp('img', { prompt: 'x' })
    expect(upstream.requests[0]!.body).toMatchObject({ model: V45, sequential_image_generation_options: { max_images: 3 } })
    // 5.0 没有 maxImages：默认值对它不生效，也不报错
    await service.executeApp('img', { model: PRO, prompt: 'x' })
    expect(upstream.requests[1]!.body).not.toHaveProperty('sequential_image_generation')
  })

  it('checkModel：一个模型用不了只标它不可用，选它回 unavailable；全都用不了整个应用才不可用', async () => {
    const driver = defineDriver<null>({
      type: 'fake',
      description: '测试驱动',
      parseProvider: () => null,
      operations: {
        echo: {
          description: '回显模型名',
          prepare: () => ({
            category: 'text',
            params: { prompt: { type: 'string' } },
            checkModel: (model) => (model.startsWith('bad') ? `${model} 解析不了` : null),
            submit: async (_values, _ctx, model) => ({ done: true, output: { outputs: [{ kind: 'text', text: model! }] } }),
          }),
        },
      },
    })
    const build = (model: string[]) =>
      createAppsService(
        buildCatalog({ providers: { p: { type: 'fake' } }, apps: { a: { provider: 'p', operation: 'echo', model } } }, 't', {
          drivers: [driver],
          env: { envVar: () => undefined, appRoot: '/' },
          defaultTimeoutMs: 1000,
        }),
      )
    const service = build(['bad-1', 'good'])
    const app = service.get('a')!
    expect(app.unavailable).toBeUndefined()
    // 默认模型跳过用不了的
    expect(app.defaultModel).toBe('good')
    expect(app.models[0]!.unavailable).toBe('bad-1 解析不了')
    expect((await service.executeApp('a', {})).outputs[0]!.text).toBe('good')
    await expect(service.executeApp('a', { model: 'bad-1' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(build(['bad-1', 'bad-2']).get('a')!.unavailable).toMatch(/bad-1 解析不了.*bad-2 解析不了/)
  })
})
