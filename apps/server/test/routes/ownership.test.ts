import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeFreshOrms, importFreshApp } from '../helpers/fresh-app.ts'
import { routeRole, routeTable } from '../helpers/routes.ts'

/**
 * 路由按角色归属（docs/28 §3.2）。表由入口声明推出（底座的 + 每个模块的 `routes`），服务端的角色闸门、
 * dev:cluster 的前置代理读的是同一份；ingress（k8s/variants/roles/ingress.yaml）由 `test/k8s/roles-manifests.test.ts` 核对。
 */
describe('routeRole', () => {
  it.each([
    ['/api/health', 'any'],
    ['/api/health/ready', 'any'],
    ['/api/agent-gateway/model/main/api/stream', 'agent'],
    ['/ws/collaboration', 'collab'],
    ['/api/collab/health', 'collab'],
    ['/api/flows/f1/doc', 'collab'],
    ['/api/flows/f1', 'web'],
    ['/api/flows/f1/duplicate', 'web'],
    ['/api/flows/f1/agent/messages', 'web'],
    ['/api/flows/f1/doc-history', 'web'],
    ['/api/projects', 'web'],
    ['/api/auth/me', 'web'],
    ['/', 'web'],
    ['/login', 'web'],
  ])('%s → %s', (path, role) => {
    expect(routeRole(path)).toBe(role)
  })

  it('免登录的入口只有声明了 public 的那几条', () => {
    const open = routeTable.routes.filter((route) => route.access === 'public').map((route) => `${route.owner} ${route.path}`)
    expect(open.sort()).toEqual([
      'agent /api/agent-gateway',
      'auth /api/auth',
      'auth /auth/login-done',
      'auth /login',
      'collab /ws/collaboration',
      'core /api/health',
    ])
  })
})

describe('角色闸门：本进程不扮演的角色的路由 404', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    await closeFreshOrms()
  })

  async function appWithRoles(roles: string) {
    vi.stubEnv('SERVER_ROLES', roles)
    // 按这组角色装一遍（归属表、本进程加载的模块都跟着角色走）
    return importFreshApp()
  }

  it('只有 web：协同和网关的路由 404，并说明归谁；健康检查照常', async () => {
    const app = await appWithRoles('web')

    const doc = await app.request('/api/flows/f1/doc')
    expect(doc.status).toBe(404)
    expect(((await doc.json()) as { message: string }).message).toContain('归 collab 角色')
    expect((await app.request('/api/agent-gateway/run/redeem', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/api/health')).status).toBe(200)
  })

  it('只有 collab：底座接口 404', async () => {
    const app = await appWithRoles('collab')
    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { message: string }).message).toContain('归 web 角色')
  })

  it('全部角色：什么都不拦', async () => {
    const app = await appWithRoles('')
    expect((await app.request('/api/auth/config')).status).toBe(200)
  })
})
