import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadedFeatures } from '@shadecn/server-kit/kernel'
import { app } from '@shadecn/server-core/app'

/**
 * 平台装配（docs/28 §3.1）：模块清单里的模块按声明自己挂路由，配置开关关掉的模块的入口不存在。
 * `test/setup.ts` 已经按全部角色装配过一次（`app` 就是那一份）。
 */

const mounted = (target: { routes: readonly { path: string }[] }, prefix: string) =>
  target.routes.some((route) => route.path.startsWith(prefix))

describe('按清单装配', () => {
  it('全部角色：清单里的模块都加载（apps 除外：测试环境没有配置应用），各自的入口都挂上了', () => {
    expect(loadedFeatures()).toEqual({ auth: true, canvas: true, storage: true, collab: true, agent: true, apps: false })
    for (const prefix of ['/api/auth', '/api/projects', '/api/flows/:flowId/doc', '/api/flows/:flowId/agent', '/api/flows/:flowId/assets', '/api/agent-gateway']) {
      expect(mounted(app, prefix), prefix).toBe(true)
    }
  })
})

describe('配置关掉的模块', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('MODULES_AGENT_ENABLED=false：agent 的入口不存在，能力表里是 false，原因写明出处', async () => {
    vi.stubEnv('MODULES_AGENT_ENABLED', 'false')
    vi.resetModules()
    const fresh = await import('@shadecn/server-core/app')
    const { assemble, prepare } = await import('@shadecn/server-core/server')
    const kernel = await import('@shadecn/server-kit/kernel')
    await prepare((await import('../modules.ts')).modules)

    const { resolved, loaded } = await assemble({ app: fresh.app, server: createServer() })

    expect(kernel.loadedFeatures()).toMatchObject({ canvas: true, agent: false })
    // 测试环境没有配置应用，apps 也在跳过名单里（原因是它自己的 enabled 判定），这里只看 agent 那一条
    expect(resolved.skipped.filter((item) => item.module.name !== 'apps')).toMatchObject([
      { module: { name: 'agent' }, detail: expect.stringContaining('MODULES_AGENT_ENABLED') },
    ])
    expect(mounted(fresh.app, '/api/flows/:flowId/agent')).toBe(false)
    expect(mounted(fresh.app, '/api/agent-gateway')).toBe(false)
    expect(mounted(fresh.app, '/api/flows/:flowId/doc')).toBe(true)
    await loaded.shutdown()
  })

  it('关掉被硬依赖的模块（canvas）→ 装配失败，说明是配置关的', async () => {
    vi.stubEnv('MODULES_CANVAS_ENABLED', 'false')
    vi.resetModules()
    const fresh = await import('@shadecn/server-core/app')
    const { assemble, prepare } = await import('@shadecn/server-core/server')
    await prepare((await import('../modules.ts')).modules)
    await expect(assemble({ app: fresh.app, server: createServer() })).rejects.toThrow(/依赖 canvas.*MODULES_CANVAS_ENABLED/)
  })
})
