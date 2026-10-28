import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuthVariables,
  requireAuth,
  requireRole,
  withSession,
} from '../../auth/middleware.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { CLIENT_ID, stubOidcFetch } from '../helpers/oidc.ts'
import { signIn } from '../helpers/session.ts'

beforeEach(async () => {
  await resetDb()
  stubOidcFetch()
})

type Mw = {
  withSession: typeof withSession
  requireAuth: typeof requireAuth
  requireRole: typeof requireRole
}

function buildApp(mw: Mw) {
  return new Hono<{ Variables: AuthVariables }>()
    .use('*', mw.withSession)
    .get('/who', (c) => c.json({ user: c.get('user'), hasSession: Boolean(c.get('session')) }))
    .get('/protected', mw.requireAuth, (c) => c.json({ ok: true }))
    .get('/admin', mw.requireRole('admin'), (c) => c.json({ ok: true }))
    .get('/staff', mw.requireRole('admin', 'editor'), (c) => c.json({ ok: true }))
}

const app = buildApp({ withSession, requireAuth, requireRole })

describe('withSession', () => {
  it('匿名请求也放行，只是 user 为 null', async () => {
    const res = await app.request('/who')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ user: null, hasSession: false })
  })

  it('带合法 cookie 时把用户挂到 context 上', async () => {
    const { cookie, user } = await signIn({ roles: ['admin'] })
    const res = await app.request('/who', { headers: { cookie } })

    const body = (await res.json()) as { user: { id: string; roles: string[] } }
    expect(body.user).toMatchObject({ id: user.id, username: 'alice', roles: ['admin'] })
  })

  it('挂到 context 上的 user 不含任何 token', async () => {
    const { cookie } = await signIn()
    const body = await (await app.request('/who', { headers: { cookie } })).text()

    expect(body).not.toContain('access')
    expect(body).not.toContain('refresh-1')
  })

  it('cookie 还在但会话已经没了 → 顺手把 cookie 清掉', async () => {
    const { cookie } = await signIn()
    await prisma.session.deleteMany()

    const res = await app.request('/who', { headers: { cookie } })
    const setCookie = res.headers.get('set-cookie') ?? ''

    expect(setCookie).toContain('sid=')
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })

  it('乱填的 cookie 当匿名处理，不报错', async () => {
    const res = await app.request('/who', { headers: { cookie: 'sid=garbage' } })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ user: null })
  })
})

describe('requireAuth', () => {
  it('未登录 → 401（前端拿到 401 会跳登录页）', async () => {
    const res = await app.request('/protected')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized', message: '需要登录' })
  })

  it('已登录 → 放行', async () => {
    const { cookie } = await signIn()
    const res = await app.request('/protected', { headers: { cookie } })
    expect(res.status).toBe(200)
  })
})

describe('requireRole', () => {
  it('未登录 → 401', async () => {
    expect((await app.request('/admin')).status).toBe(401)
  })

  it('登录了但没这个角色 → 403，并说明缺哪个角色', async () => {
    const { cookie } = await signIn({ roles: ['user'] })
    const res = await app.request('/admin', { headers: { cookie } })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden', message: '需要角色：admin' })
  })

  it('有角色 → 放行', async () => {
    const { cookie } = await signIn({ roles: ['admin'] })
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(200)
  })

  it('多个角色是「任意一个」即可', async () => {
    const { cookie } = await signIn({ roles: ['editor'] })
    expect((await app.request('/staff', { headers: { cookie } })).status).toBe(200)
  })

  it('client 角色要带 clientId: 前缀才算数', async () => {
    const scoped = buildApp({ withSession, requireAuth, requireRole })
    scoped.get('/ops', requireRole(`${CLIENT_ID}:ops`), (c) => c.json({ ok: true }))

    const plain = await signIn({ subject: 'u-plain', roles: ['ops'] })
    expect((await scoped.request('/ops', { headers: { cookie: plain.cookie } })).status).toBe(403)

    const scopedUser = await signIn({ subject: 'u-scoped', roles: [`${CLIENT_ID}:ops`] })
    expect((await scoped.request('/ops', { headers: { cookie: scopedUser.cookie } })).status).toBe(
      200,
    )
  })
})

describe('没配 Keycloak 时（authEnabled=false）', () => {
  async function loadDisabledApp() {
    vi.resetModules()
    vi.stubEnv('KEYCLOAK_ISSUER', '')
    vi.stubEnv('KEYCLOAK_CLIENT_ID', '')
    const mw = (await import('../../auth/middleware.ts')) as Mw
    return buildApp(mw)
  }

  it('requireAuth 全部放行，方便本地只跑前端 demo', async () => {
    const disabled = await loadDisabledApp()
    expect((await disabled.request('/protected')).status).toBe(200)
  })

  it('requireRole 也全部放行', async () => {
    const disabled = await loadDisabledApp()
    expect((await disabled.request('/admin')).status).toBe(200)
  })

  it('withSession 不去查库，user 始终为 null', async () => {
    const { cookie } = await signIn()
    const disabled = await loadDisabledApp()

    await expect((await disabled.request('/who', { headers: { cookie } })).json()).resolves.toEqual({
      user: null,
      hasSession: false,
    })
  })
})
