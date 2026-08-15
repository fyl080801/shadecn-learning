import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../app.ts'
import { resetDb } from './helpers/db.ts'
import { stubOidcFetch } from './helpers/oidc.ts'
import { signIn } from './helpers/session.ts'

const APP_ORIGIN = 'http://127.0.0.1:3000'

// Hono 的路由表一旦收到第一个请求就冻结了，会抛异常的探针路由必须在这儿先挂好
app.get('/api/boom', () => {
  throw new Error('炸了')
})

beforeEach(async () => {
  await resetDb()
  stubOidcFetch()
  // hono 的 logger 会往 stdout 刷一堆东西，测试里安静点
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('/api/* 的登录闸门', () => {
  it.each([['/api/health'], ['/api/auth/config'], ['/api/auth/me']])(
    '%s 是公开接口，匿名也能访问',
    async (path) => {
      expect((await app.request(path)).status).toBe(200)
    },
  )

  it.each([['/api/notes'], ['/api/collab/rooms']])('%s 匿名访问 → 401', async (path) => {
    const res = await app.request(path)

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('登录之后受保护接口正常返回', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/api/notes', { headers: { cookie } })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toBeInstanceOf(Array)
  })

  it('公开前缀是按路径段匹配的，/api/healthz 骗不过闸门', async () => {
    expect((await app.request('/api/healthz')).status).toBe(401)
  })

  it('/api/authorize 这种前缀相近的也拦得住', async () => {
    expect((await app.request('/api/authorize')).status).toBe(401)
  })
})

describe('404 / 500 处理', () => {
  it('/api 下找不到的接口返回 JSON 404，带上 path', async () => {
    const { cookie } = await signIn()
    const res = await app.request('/api/nope', { headers: { cookie } })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Not Found', path: '/api/nope' })
  })

  it('非 /api 的未命中返回纯文本（正常情况下会被前端中间件接走）', async () => {
    const res = await app.request('/some/page')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/plain')
    await expect(res.text()).resolves.toBe('Not Found')
  })

  it('路由抛异常时统一转成 500 JSON，不把栈吐给前端', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { cookie } = await signIn()

    const res = await app.request('/api/boom', { headers: { cookie } })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'Internal Server Error',
      message: '炸了',
    })
  })
})

describe('CORS', () => {
  it('同源请求带上 ACAO 和 credentials', async () => {
    const res = await app.request('/api/health', { headers: { origin: APP_ORIGIN } })

    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('别的站点拿不到 ACAO —— 带 cookie 的接口不能对任意站开', async () => {
    const res = await app.request('/api/health', { headers: { origin: 'https://evil.example' } })

    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
  })

  it('非 /api 的路径不套 CORS', async () => {
    const res = await app.request('/some/page', { headers: { origin: APP_ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
