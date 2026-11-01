import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { DRIVERS } from '../src/drivers/index.ts'

/** 仓库根的 `apps.example.yaml` 是发布出去的示例：它必须能被解析，密钥给齐时每个应用都可用 */
describe('apps.example.yaml', () => {
  const file = fileURLToPath(new URL('../../../apps.example.yaml', import.meta.url))
  const load = (env: Record<string, string>) =>
    loadCatalog(file, { drivers: DRIVERS, env: { envVar: (name) => env[name], appRoot: '/' }, defaultTimeoutMs: 1000 })

  it('能解析；给了 ARK_API_KEY 每个应用都可用，每个模型都套上了档案', () => {
    const catalog = load({ ARK_API_KEY: 'k' })
    const apps = [...catalog.apps.values()].map((entry) => entry.info)
    expect(apps.map((app) => app.id)).toEqual(['seedream', 'seedance', 'seed3d'])
    for (const app of apps) {
      expect(app.unavailable).toBeUndefined()
      for (const model of app.models) expect(model.title, `${app.id} / ${model.id}`).toBeTruthy()
    }
  })

  it('没给密钥：应用标成不可用，不是启动错误', () => {
    const catalog = load({})
    expect(catalog.apps.get('seedream')!.info.unavailable).toMatch(/ARK_API_KEY/)
  })
})
