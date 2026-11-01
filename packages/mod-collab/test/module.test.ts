import { beforeAll, describe, expect, it } from 'vitest'
import { activeDependencies, buildRouteTable } from '@shadecn/server-kit/kernel'
import { configurePlatform, type Platform } from '@shadecn/server-kit/platform'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import { isAllowedCollabOrigin } from '../src/authorize.ts'
import collab, { COLLAB_MONITOR_PATH, FLOW_DOC_PATH } from '../src/module.ts'

/**
 * 协同模块的声明（docs/28 §3.1.2 / §3.4）：入口归 collab 角色 —— 只有 agent 角色的进程里内核不让它认领 WebSocket，于是 headless。
 * 接上数据库和真房间之后的样子由 server project 的用例守着（它们装配整个平台）。
 */
describe('协同模块的声明', () => {
  it('随 collab 和 agent 角色加载，入口全归 collab；WebSocket 自己鉴权所以不经登录闸门', () => {
    expect(collab.roles).toEqual(['collab', 'agent'])
    const table = buildRouteTable((collab.routes ?? []).map((route) => ({ ...route, owner: 'collab' })))
    expect(table.match(COLLAB_PATH)).toMatchObject({ role: 'collab', access: 'public', kind: 'upgrade' })
    expect(table.match('/api/collab/rooms')).toMatchObject({ path: COLLAB_MONITOR_PATH, role: 'collab', access: 'user' })
    expect(table.match('/api/flows/f1/doc')).toMatchObject({ path: FLOW_DOC_PATH, role: 'collab', access: 'user' })
  })

  it('硬依赖画布（判权、内容存取都经 canvas 服务）', () => {
    expect(activeDependencies(collab, new Set(['agent']))).toEqual(['canvas'])
  })
})

describe('isAllowedCollabOrigin：WebSocket 的 Origin（CSWSH）', () => {
  beforeAll(() => {
    configurePlatform({
      origins: { isAllowed: (origin: string | null | undefined) => origin === 'https://app.example.com' },
    } as unknown as Platform)
  })

  it('没有 Origin（非浏览器）、白名单里的、和 Host 同源的 → 放行', () => {
    expect(isAllowedCollabOrigin(undefined, 'app.example.com')).toBe(true)
    expect(isAllowedCollabOrigin('https://app.example.com', 'internal.svc')).toBe(true)
    expect(isAllowedCollabOrigin('http://localhost:3000', 'localhost:3000')).toBe(true)
  })

  it('跨站的、不是合法 URL 的 → 拒绝', () => {
    expect(isAllowedCollabOrigin('https://evil.example', 'app.example.com')).toBe(false)
    expect(isAllowedCollabOrigin('null', 'app.example.com')).toBe(false)
  })
})
