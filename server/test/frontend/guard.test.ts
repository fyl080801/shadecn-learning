import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app.ts'
import { resetDb } from '../helpers/db.ts'
import { stubOidcFetch } from '../helpers/oidc.ts'
import { signIn } from '../helpers/session.ts'

/** 浏览器打开页面时的请求头（Chrome 的整页导航长这样） */
const NAVIGATION = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate',
}

beforeEach(async () => {
  await resetDb()
  stubOidcFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('页面闸门', () => {
  it('未登录打开首页 → 302 到登录页，原地址记在 redirect 里', async () => {
    const res = await app.request('/2048?level=3', { headers: NAVIGATION })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `/login?redirect=${encodeURIComponent('/2048?level=3')}`,
    )
  })

  it('未登录时前端资源一律不下发（401，不是 302）', async () => {
    // 这类请求 redirect 过去只会把 HTML 当成 js 塞给浏览器
    const res = await app.request('/assets/index-abc123.js')

    expect(res.status).toBe(401)
  })

  it('dev 下的源码请求同样拿不到', async () => {
    const res = await app.request('/src/main.ts')

    expect(res.status).toBe(401)
  })

  it('登录之后页面请求才放行（这里没挂前端中间件，落到 404）', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/2048', { headers: { ...NAVIGATION, cookie } })

    expect(res.status).toBe(404)
  })

  it('/api/* 不走页面闸门，匿名拿到的仍然是 JSON 401', async () => {
    const res = await app.request('/api/notes', { headers: NAVIGATION })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('站外 redirect 不会被原样带进登录页', async () => {
    const res = await app.request('//evil.example/pwn', { headers: NAVIGATION })

    expect(res.headers.get('location')).toBe('/login?redirect=%2F')
  })
})

describe('GET /login', () => {
  it('匿名可访问，返回服务端渲染的 HTML，不含任何前端入口', async () => {
    const res = await app.request('/login', { headers: NAVIGATION })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain('使用 Keycloak 登录')
    expect(html).not.toContain('/src/main.ts')
    expect(html).not.toContain('<script')
  })

  it('登录按钮指向后端登录入口，并把 redirect 透传下去', async () => {
    const res = await app.request('/login?redirect=%2F2048', { headers: NAVIGATION })

    await expect(res.text()).resolves.toContain(
      `href="/api/auth/login?redirect=${encodeURIComponent('/2048')}"`,
    )
  })

  it('站外 redirect 回落到 /', async () => {
    const res = await app.request('/login?redirect=https%3A%2F%2Fevil.example', {
      headers: NAVIGATION,
    })

    await expect(res.text()).resolves.toContain('href="/api/auth/login?redirect=%2F"')
  })

  it('?error= 展示在页面上，且做了 HTML 转义', async () => {
    const res = await app.request(`/login?error=${encodeURIComponent('<img src=x>失败')}`, {
      headers: NAVIGATION,
    })
    const html = await res.text()

    expect(html).toContain('&lt;img src=x&gt;失败')
    expect(html).not.toContain('<img src=x>')
  })

  it('已经登录了就别停在登录页', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/login?redirect=%2F2048', {
      headers: { ...NAVIGATION, cookie },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2048')
  })
})
