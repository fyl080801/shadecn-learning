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

  /**
   * 闸门守的是「看不到界面」，不是「拿不到字节」：**登录页本身就是前端 bundle
   * 的一个入口**，把静态资源一起挡掉，登录页自己就白屏了。
   *
   * 光有 bundle 渲染不出任何东西 —— 起 SPA 要 `index.html`，而那是一次整页导航，
   * 上面那条已经把它挡在登录页外面了。
   */
  it.each([
    ['构建产物', '/assets/index-abc123.js'],
    ['dev 下的源码', '/src/main.ts'],
    ['Vite 客户端', '/@vite/client'],
    ['样式', '/assets/index-abc123.css'],
  ])('未登录也能取到%s（放行，不是 401）', async (_label, path) => {
    const res = await app.request(path)

    // 这里没挂前端中间件，所以落到 404 —— 关键是**不是** 401/302
    expect(res.status).toBe(404)
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

/**
 * 登录页的**页面本体**已经不在服务端了 —— 它是 `login.html` 这个 Vite 入口，
 * 由前端层（dev 的 Vite 中间件 / prod 的静态目录）发出来，内容归
 * `src/test/login/LoginPage.test.ts` 管。
 *
 * 这里只剩服务端那两条职责：匿名放得进去、已登录的别停在这儿。
 */
describe('GET /login', () => {
  it('匿名放行，交给前端层发 HTML（这里没挂它，所以落到 404 而不是 302/401）', async () => {
    const res = await app.request('/login', { headers: NAVIGATION })

    expect(res.status).toBe(404)
  })

  it('已经登录了就别停在登录页', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/login?redirect=%2F2048', {
      headers: { ...NAVIGATION, cookie },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2048')
  })

  it('已登录时站外 redirect 同样回落到 /，别拿登录页做跳板', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/login?redirect=%2F%2Fevil.example%2Fpwn', {
      headers: { ...NAVIGATION, cookie },
    })

    expect(res.headers.get('location')).toBe('/')
  })
})

describe('GET /auth/login-done', () => {
  it('登录完成后落在这里，只负责通知开它的那一页，不加载 SPA', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/auth/login-done', {
      headers: { ...NAVIGATION, cookie },
    })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain('postMessage')
    expect(html).toContain('app-auth:login-done')
    // 消息只发给同源，别人监听不到
    expect(html).toContain('window.location.origin')
    expect(html).not.toContain("/src/login/main.ts")
  })

  it('没登录成功就还是被闸门送回登录页（登录窗口里再登一次）', async () => {
    const res = await app.request('/auth/login-done', { headers: NAVIGATION })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `/login?redirect=${encodeURIComponent('/auth/login-done')}`,
    )
  })
})
