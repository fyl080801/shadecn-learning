import { fileURLToPath } from 'node:url'
import { parseConfigFile } from '@shadecn/server-kit/config'
import { describe, expect, it } from 'vitest'
import { catalogFromConfig } from '../src/catalog.ts'
import { DRIVERS } from '../src/drivers/index.ts'

/**
 * `sample/server.config.example.yaml` 是发布出去的示例，它的 `modules.apps` 段写的是实际内容（方舟的模型）：
 * 必须能被解析，密钥给齐时每个应用都可用，每个模型的收窄都在。
 */
describe('server.config.example.yaml 的 modules.apps', () => {
  const file = fileURLToPath(new URL('../../../sample/server.config.example.yaml', import.meta.url))
  const section = (parseConfigFile(file) as { modules: { apps: { providers: unknown; apps: unknown } } }).modules.apps
  const load = (env: Record<string, string>) =>
    catalogFromConfig(section, { drivers: DRIVERS, env: { envVar: (name) => env[name], appRoot: '/', llmProviders: {} }, defaultTimeoutMs: 1000 })

  it('能解析；平铺成一个模型一项，给了 ARK_API_KEY 每个应用都可用，标题都显式写了', () => {
    const apps = [...load({ ARK_API_KEY: 'k' }).apps.values()].map((entry) => entry.info)
    expect(apps.map((app) => [app.id, app.category, app.title])).toEqual([
      ['ark:doubao-seedream-5-0-pro-260628', 'image', 'Seedream 5.0 pro'],
      ['ark:doubao-seedream-5-0-flash-260915', 'image', 'Seedream 5.0 flash'],
      ['ark:doubao-seedance-2-0-260128', 'video', 'Seedance 2.0'],
      ['ark:doubao-seedance-2-0-fast-260128', 'video', 'Seedance 2.0 fast'],
      ['ark:doubao-seedance-1-0-pro-250528', 'video', 'Seedance 1.0 pro'],
      ['ark:doubao-seed3d-2-0-260328', '3d', 'Seed3D 2.0'],
    ])
    for (const app of apps) expect(app.unavailable, app.id).toBeUndefined()
  })

  it('每个模型的收窄写在自己的条目里：5.0 pro / flash、Seedance 各代', () => {
    const catalog = load({ ARK_API_KEY: 'k' })
    const params = (id: string) => catalog.apps.get(`ark:${id}`)!.info.params
    for (const model of ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915']) {
      expect(params(model).image!.maxLength, model).toBe(10)
      expect(params(model).maxImages, model).toBeUndefined()
      expect(params(model).size, model).toMatchObject({ tiers: ['1K', '1.5K', '2K'], maxPixels: 4624220, default: '2K' })
      expect(params(model).size!.presets!['16:9'], model).toEqual(['1424x800', '2048x1152', '2816x1584'])
    }
    expect(params('doubao-seedance-2-0-260128').duration!.max).toBe(15)
    expect(params('doubao-seedance-2-0-260128').seed).toBeUndefined()
    expect(params('doubao-seedance-2-0-fast-260128').resolution!.enum).toEqual(['480p', '720p'])
    expect(params('doubao-seedance-1-0-pro-250528').lastFrame).toBeUndefined()
    expect(params('doubao-seedance-1-0-pro-250528').duration).toMatchObject({ min: 2, max: 12 })
  })

  it('视频应用的时限写在条目上，覆盖默认', () => {
    const catalog = load({ ARK_API_KEY: 'k' })
    expect(catalog.apps.get('ark:doubao-seedance-2-0-260128')!.timeoutMs).toBe(900000)
    expect(catalog.apps.get('ark:doubao-seed3d-2-0-260328')!.timeoutMs).toBe(1000)
  })

  it('没给密钥：应用标成不可用，不是启动错误', () => {
    const catalog = load({})
    expect(catalog.apps.size).toBe(6)
    expect(catalog.apps.get('ark:doubao-seedream-5-0-pro-260628')!.info.unavailable).toMatch(/ARK_API_KEY/)
  })
})
