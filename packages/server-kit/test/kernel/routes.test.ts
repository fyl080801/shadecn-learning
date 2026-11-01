import { describe, expect, it } from 'vitest'
import { buildRouteTable, describeRouteTable, routeCovers, type OwnedRoute } from '../../src/kernel/routes.ts'

const table = buildRouteTable([
  { owner: 'core', path: '/api/health', role: 'any', access: 'public' },
  { owner: 'canvas', path: '/api/flows', role: 'web', access: 'user' },
  { owner: 'collab', path: '/api/flows/:flowId/doc', role: 'collab', access: 'user' },
  { owner: 'agent', path: '/api/agent-gateway', role: 'agent', access: 'public' },
  { owner: 'collab', path: '/ws/collaboration', role: 'collab', access: 'public', kind: 'upgrade' },
])

describe('入口声明的路径匹配', () => {
  it('一条声明覆盖它自己和其下所有子路径；参数段匹配任意一段', () => {
    expect(routeCovers('/api/collab', '/api/collab')).toBe(true)
    expect(routeCovers('/api/collab', '/api/collab/rooms')).toBe(true)
    expect(routeCovers('/api/collab', '/api/collaboration')).toBe(false)
    expect(routeCovers('/api/flows/:flowId/doc', '/api/flows/f1/doc')).toBe(true)
    expect(routeCovers('/api/flows/:flowId/doc', '/api/flows/f1')).toBe(false)
  })

  it('多条都匹配时取最具体的那条', () => {
    expect(table.match('/api/flows/f1/doc')?.owner).toBe('collab')
    expect(table.match('/api/flows/f1')?.owner).toBe('canvas')
    expect(table.match('/api/flows/f1/duplicate')?.owner).toBe('canvas')
    expect(table.match('/api/agent-gateway/run/1')?.access).toBe('public')
    expect(table.match('/projects')).toBeUndefined()
  })

  it('同一条入口被两处声明 → 建表就抛（参数名不同也算同一条）', () => {
    const dup: OwnedRoute[] = [
      { owner: 'a', path: '/api/flows/:id/x', role: 'web', access: 'user' },
      { owner: 'b', path: '/api/flows/:flowId/x', role: 'web', access: 'user' },
    ]
    expect(() => buildRouteTable(dup)).toThrow('同时被 a 和 b 声明')
  })

  it('路径写法不合法 → 抛', () => {
    expect(() => buildRouteTable([{ owner: 'a', path: '/api/x/*', role: 'web', access: 'user' }])).toThrow('通配符')
    expect(() => buildRouteTable([{ owner: 'a', path: 'api/x', role: 'web', access: 'user' }])).toThrow('/ 开头')
  })

  it('给前置分流看的表：不列 web 的，最具体的在前', () => {
    expect(describeRouteTable(table)).toEqual([
      { path: '/api/flows/:flowId/doc', role: 'collab', kind: 'http' },
      { path: '/api/agent-gateway', role: 'agent', kind: 'http' },
      { path: '/api/health', role: 'any', kind: 'http' },
      { path: '/ws/collaboration', role: 'collab', kind: 'upgrade' },
    ])
  })
})
