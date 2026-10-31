import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeRole } from '../../routes/ownership.ts'
import { routeRole as proxyRouteRole } from '../../scripts/dev-route.mjs'

/**
 * 路由按角色归属（docs/28 §3.2）。这张表和 ingress（k8s/ingress.yaml）、dev:cluster 的前置代理是同一份分流规则。
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
  ])('%s → %s（服务端的表和 dev:cluster 前置代理的表一致）', (path, role) => {
    expect(routeRole(path)).toBe(role)
    expect(proxyRouteRole(path)).toBe(role)
  })
})

describe('roleGate：本进程不扮演的角色的路由 404', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function appWithRoles(roles: string) {
    vi.stubEnv('SERVER_ROLES', roles)
    vi.resetModules()
    return (await import('../../app.ts')).app
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
