import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import {
  AUTHORIZATION_ENDPOINT,
  CLIENT_ID,
  END_SESSION_ENDPOINT,
  ISSUER,
  REDIRECT_URI,
  cookieValue,
  discoveryDoc,
  signJwt,
  stubOidcFetch,
  tokenResponse,
} from '../helpers/oidc.ts'
import { signIn } from '../helpers/session.ts'

let stub: ReturnType<typeof stubOidcFetch>

beforeEach(async () => {
  await resetDb()
  stub = stubOidcFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

/**
 * discovery 有 10 分钟的模块级缓存，一旦拉成功过，后面再改 stub.discovery 也没用。
 * 要测「Keycloak 连不上」这类分支就得拿一份全新的模块图。
 * db.ts 的 PrismaClient 挂在 globalThis 上、session 密钥来自同一份 env，
 * 所以新旧模块共用同一个库、同一批 cookie。
 */
async function freshApp() {
  vi.resetModules()
  return (await import('../../app.ts')).app
}

/** 走一遍 /login，把落库的授权请求和 oidc_tx cookie 一起拿回来 */
async function startLogin(query = '') {
  const res = await app.request(`/api/auth/login${query}`)
  const txId = cookieValue(res, 'oidc_tx')
  const request = txId ? await prisma.authRequest.findUnique({ where: { id: txId } }) : null
  return { res, txId, request }
}

/** 拼一个从 Keycloak 跳回来的回调地址 */
function callback(params: Record<string, string>, txId?: string | null) {
  const search = new URLSearchParams(params).toString()
  return app.request(
    `/api/auth/callback?${search}`,
    txId ? { headers: { cookie: `oidc_tx=${txId}` } } : undefined,
  )
}

describe('GET /api/auth/config', () => {
  it('告诉前端登录已开启以及入口在哪', async () => {
    const res = await app.request('/api/auth/config')

    await expect(res.json()).resolves.toEqual({
      enabled: true,
      provider: 'keycloak',
      issuer: ISSUER,
      clientId: CLIENT_ID,
      loginUrl: '/api/auth/login',
      logoutUrl: '/api/auth/logout',
    })
  })
})

describe('GET /api/auth/me', () => {
  it('匿名也返回 200（前端守卫不用处理异常分支）', async () => {
    const res = await app.request('/api/auth/me')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      enabled: true,
      authenticated: false,
      user: null,
      expiresAt: null,
    })
  })

  it('已登录时返回用户信息和会话过期时间', async () => {
    const { cookie, user } = await signIn({ roles: ['admin'] })
    const res = await app.request('/api/auth/me', { headers: { cookie } })

    const body = (await res.json()) as {
      authenticated: boolean
      user: { id: string; roles: string[] }
      expiresAt: string
    }
    expect(body.authenticated).toBe(true)
    expect(body.user).toMatchObject({ id: user.id, email: 'alice@example.com', roles: ['admin'] })
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt)
  })

  it('响应里没有任何 token', async () => {
    const { cookie } = await signIn()
    const text = await (await app.request('/api/auth/me', { headers: { cookie } })).text()

    expect(text).not.toContain('refresh-1')
    expect(text).not.toContain('access_token')
  })
})

describe('GET /api/auth/login', () => {
  it('302 到 Keycloak，参数带齐 state/nonce/PKCE', async () => {
    const { res, request } = await startLogin()

    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location') ?? '')
    expect(url.origin + url.pathname).toBe(AUTHORIZATION_ENDPOINT)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(request?.state)
    expect(url.searchParams.get('nonce')).toBe(request?.nonce)
  })

  it('state/nonce/code_verifier 落库，浏览器只拿到一个 oidc_tx cookie', async () => {
    const { res, txId, request } = await startLogin()

    expect(txId).toBeTruthy()
    expect(request?.codeVerifier).toBeTruthy()
    // code_verifier 绝对不能出现在给浏览器的任何东西里
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).not.toContain(request?.codeVerifier ?? '__none__')
    expect(res.headers.get('location')).not.toContain(request?.codeVerifier ?? '__none__')
  })

  it('oidc_tx cookie 是 httpOnly 且只对 /api/auth 生效', async () => {
    const { res } = await startLogin()
    const setCookie = res.headers.get('set-cookie') ?? ''

    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Path=/api/auth')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('发出去的 code_challenge = S256(库里的 code_verifier)', async () => {
    const { res, request } = await startLogin()
    const { codeChallengeOf } = await import('../../auth/oidc.ts')

    const sent = new URL(res.headers.get('location') ?? '').searchParams.get('code_challenge')
    expect(sent).toBe(codeChallengeOf(request?.codeVerifier ?? ''))
  })

  it('?redirect= 的站内路径会被记下来', async () => {
    const { request } = await startLogin('?redirect=/2048')
    expect(request?.redirectTo).toBe('/2048')
  })

  it.each([
    ['协议相对地址', '//evil.example/pwn'],
    ['反斜杠绕过', '/\\evil.example'],
    ['绝对地址', 'https://evil.example'],
    ['不以 / 开头', 'evil'],
  ])('%s 的 open redirect 被挡掉，回落到 /', async (_label, redirect) => {
    const { request } = await startLogin(`?redirect=${encodeURIComponent(redirect)}`)
    expect(request?.redirectTo).toBe('/')
  })

  it('已经登录就不再走一遍授权，直接跳回目标页', async () => {
    const { cookie } = await signIn()
    const res = await app.request('/api/auth/login?redirect=/2048', { headers: { cookie } })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2048')
    expect(await prisma.authRequest.count()).toBe(0)
  })

  it('连不上 Keycloak 时跳回登录页报错，并把没用上的授权请求删掉', async () => {
    stub.discovery = { status: 500, body: null }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await (await freshApp()).request('/api/auth/login')

    expect(res.headers.get('location')).toContain('/login?error=')
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('KEYCLOAK_ISSUER')
    expect(await prisma.authRequest.count()).toBe(0)
  })
})

describe('GET /api/auth/callback', () => {
  it('完整走通：换 token → 验 id_token → 建会话 → 跳回原页面', async () => {
    const { txId, request } = await startLogin('?redirect=/2048')
    stub.token = {
      status: 200,
      body: tokenResponse({ nonce: request?.nonce, roles: { realm: ['admin'] } }),
    }

    const res = await callback({ code: 'the-code', state: request?.state ?? '' }, txId)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2048')

    // 会话建好了，cookie 是 httpOnly 的 sid
    const sid = cookieValue(res, 'sid')
    expect(sid).toBeTruthy()
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(await prisma.session.count()).toBe(1)

    // 用户档案和角色一起落库
    const user = await prisma.user.findFirstOrThrow()
    expect(user).toMatchObject({ issuer: ISSUER, subject: 'user-1', roles: '["admin"]' })

    // 拿新 cookie 立刻就能过闸门
    const me = await app.request('/api/auth/me', { headers: { cookie: `sid=${sid}` } })
    await expect(me.json()).resolves.toMatchObject({ authenticated: true })
  })

  it('token 端点收到的是库里那个 code_verifier（PKCE 闭环）', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: request?.nonce }) }

    await callback({ code: 'the-code', state: request?.state ?? '' }, txId)

    const body = new URLSearchParams(
      stub.calls.find((c) => c.url.endsWith('/token'))?.body ?? '',
    )
    expect(body.get('code_verifier')).toBe(request?.codeVerifier)
    expect(body.get('code')).toBe('the-code')
  })

  it('授权请求是一次性的：同一个 code 重放第二次就失败', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: request?.nonce }) }

    const first = await callback({ code: 'c', state: request?.state ?? '' }, txId)
    expect(first.headers.get('location')).toBe('/')

    const replay = await callback({ code: 'c', state: request?.state ?? '' }, txId)
    expect(decodeURIComponent(replay.headers.get('location') ?? '')).toContain('state 校验失败')
    expect(await prisma.session.count()).toBe(1)
  })

  it.each([
    ['没有 oidc_tx cookie', true, false, '授权信息不完整'],
    ['没有 code', false, true, '授权信息不完整'],
  ])('%s → 跳登录页报错', async (_label, dropCookie, dropCode, message) => {
    const { txId, request } = await startLogin()
    const params: Record<string, string> = { state: request?.state ?? '' }
    if (!dropCode) params.code = 'c'

    const res = await callback(params, dropCookie ? null : txId)
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(message)
  })

  it('state 对不上 → 拒绝', async () => {
    const { txId } = await startLogin()
    const res = await callback({ code: 'c', state: 'not-my-state' }, txId)

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('state 校验失败')
    expect(await prisma.session.count()).toBe(0)
  })

  it('授权请求过期 → 提示重试', async () => {
    const { txId, request } = await startLogin()
    await prisma.authRequest.update({
      where: { id: txId ?? '' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('登录超时')
  })

  it('Keycloak 直接回 error 时把 error_description 透出来', async () => {
    const { txId } = await startLogin()
    const res = await callback(
      { error: 'access_denied', error_description: '用户取消了授权' },
      txId,
    )

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('用户取消了授权')
  })

  it('nonce 对不上（重放别人的 id_token）→ 不建会话', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: 'someone-elses-nonce' }) }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('nonce 不匹配')
    expect(await prisma.session.count()).toBe(0)
  })

  it('id_token 签名被改过 → 不建会话', async () => {
    const { txId, request } = await startLogin()
    const good = tokenResponse({ nonce: request?.nonce })
    stub.token = {
      status: 200,
      body: { ...good, id_token: `${(good.id_token as string).slice(0, -4)}AAAA` },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('签名校验失败')
    expect(await prisma.session.count()).toBe(0)
  })

  it('id_token 的 iss 是别的 realm → 不建会话', async () => {
    const { txId, request } = await startLogin()
    stub.token = {
      status: 200,
      body: tokenResponse({
        nonce: request?.nonce,
        claims: { iss: 'https://evil.test/realms/x' },
        idToken: signJwt({
          iss: 'https://evil.test/realms/x',
          sub: 'x',
          aud: CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 300,
          iat: Math.floor(Date.now() / 1000),
          nonce: request?.nonce,
        }),
      }),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('iss 不匹配')
    expect(await prisma.session.count()).toBe(0)
  })

  it('没返回 id_token 时提示去检查 scope', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: request?.nonce, idToken: null }) }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('openid')
  })

  it('回调后 oidc_tx cookie 一定被清掉（成功失败都一样）', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: request?.nonce }) }

    const res = await callback({ code: 'c', state: request?.state ?? '' }, txId)
    const cleared = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('oidc_tx='))

    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })

  it('记下 user-agent 和 x-forwarded-for 的第一跳', async () => {
    const { txId, request } = await startLogin()
    stub.token = { status: 200, body: tokenResponse({ nonce: request?.nonce }) }

    await app.request(`/api/auth/callback?code=c&state=${request?.state}`, {
      headers: {
        cookie: `oidc_tx=${txId}`,
        'user-agent': 'TestBrowser/1.0',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      },
    })

    const session = await prisma.session.findFirstOrThrow()
    expect(session.userAgent).toBe('TestBrowser/1.0')
    expect(session.ip).toBe('203.0.113.7')
  })
})

describe('GET /api/auth/logout', () => {
  it('清本地会话 + 清 cookie + 跳 Keycloak 的 end_session', async () => {
    const { cookie } = await signIn()

    const res = await app.request('/api/auth/logout', { headers: { cookie } })

    expect(await prisma.session.count()).toBe(0)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('sid=')
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(END_SESSION_ENDPOINT)
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://127.0.0.1:3000/login',
    )
    expect(location.searchParams.get('id_token_hint')).toBeTruthy()
  })

  it('顺手通知 Keycloak 作废 refresh_token', async () => {
    const { cookie } = await signIn()
    await app.request('/api/auth/logout', { headers: { cookie } })

    const revoke = stub.calls.find(
      (c) => c.url.startsWith(END_SESSION_ENDPOINT) && c.body?.includes('refresh_token'),
    )
    expect(new URLSearchParams(revoke?.body ?? '').get('refresh_token')).toBe('refresh-1')
  })

  it('没登录时也不报错，直接回登录页', async () => {
    const res = await app.request('/api/auth/logout')
    expect(res.status).toBe(302)
  })

  it('Keycloak 连不上也不能卡住登出：本地会话照样清掉，不是 500', async () => {
    const { cookie } = await signIn()
    stub.discovery = { status: 500, body: null }

    const res = await (await freshApp()).request('/api/auth/logout', { headers: { cookie } })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect(await prisma.session.count()).toBe(0)
  })

  it('discovery 里没有 end_session_endpoint 就直接回 /login', async () => {
    const { cookie } = await signIn()
    stub.discovery = {
      status: 200,
      body: { ...discoveryDoc, end_session_endpoint: undefined },
    }

    const res = await (await freshApp()).request('/api/auth/logout', { headers: { cookie } })
    expect(res.headers.get('location')).toBe('http://127.0.0.1:3000/login')
  })
})
