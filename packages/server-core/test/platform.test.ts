import { afterEach, describe, expect, it } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { AUTH_SERVICE, platform as current, type PlatformAuth } from '@shadecn/server-kit/platform'
import { defineModule } from '@shadecn/server-kit/kernel'
import { acceptProvidedService, platform, resetAuthProvider } from '../src/platform.ts'
import { buildServerRouteTable, routeRoleIn } from '../src/routes-table.ts'

afterEach(() => resetAuthProvider())

describe('平台的 auth 由模块提供', () => {
  it('没有模块提供时：未启用、认不出人、管线上的闸门放行', async () => {
    expect(current()).toBe(platform)
    expect(platform.auth.enabled).toBe(false)
    const app = new Hono().use('*', platform.auth.requireUser).get('/', (c) => c.text('ok'))
    expect((await app.request('/')).status).toBe(200)
    expect(await platform.auth.identify('sid=x')).toBeNull()
    // 没有会话密钥时每个用途随机一把，但同一个用途在本进程内稳定
    expect(platform.auth.deriveSecret('a')).toBe(platform.auth.deriveSecret('a'))
    expect(platform.auth.deriveSecret('a')).not.toBe(platform.auth.deriveSecret('b'))
  })

  it('某个模块注册了 auth 服务 → 平台的 auth 转给它（闸门、认人都是它的）', async () => {
    const deny: MiddlewareHandler = async (c) => c.json({ error: 'Unauthorized' }, 401)
    acceptProvidedService(AUTH_SERVICE, {
      enabled: true,
      userId: async () => 'u1',
      identify: async () => ({ id: 'u1', name: 'n', avatarUrl: null }),
      session: (_c, next) => next(),
      requireUser: deny,
      pageGuard: (_c, next) => next(),
      deriveSecret: () => 'derived',
    } satisfies PlatformAuth)

    expect(platform.auth.enabled).toBe(true)
    expect(await platform.auth.identify('sid=x')).toMatchObject({ id: 'u1' })
    const app = new Hono().use('*', platform.auth.requireUser).get('/', (c) => c.text('ok'))
    expect((await app.request('/')).status).toBe(401)
    // 别的服务名不碰平台
    acceptProvidedService('canvas', {})
    expect(platform.auth.deriveSecret('x')).toBe('derived')
  })
})

describe('路由归属表', () => {
  it('底座只有健康检查和能力表；其余按模块声明，没被覆盖的归 web', () => {
    const notes = defineModule({ name: 'notes', roles: ['web'], routes: [{ path: '/api/notes', role: 'web', access: 'user' }], setup() {} })
    const collab = defineModule({ name: 'collab', roles: ['collab'], routes: [{ path: '/api/collab', role: 'collab', access: 'user' }], setup() {} })
    const table = buildServerRouteTable([notes, collab])
    expect(routeRoleIn(table, '/api/health/ready')).toBe('any')
    expect(table.match('/api/health')?.access).toBe('public')
    expect(routeRoleIn(table, '/api/collab/rooms')).toBe('collab')
    expect(table.match('/api/notes/1')?.owner).toBe('notes')
    expect(routeRoleIn(table, '/projects')).toBe('web')
  })
})
