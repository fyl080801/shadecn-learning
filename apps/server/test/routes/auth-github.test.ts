import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import { identities } from '../../store/identities.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_ISSUER,
  GITHUB_TOKEN_URL,
  githubUser,
  stubGithubFetch,
} from '../helpers/github.ts'
import { cookieValue } from '../helpers/oidc.ts'
import { signIn } from '../helpers/session.ts'

/**
 * GitHub 登录 + 账号关联（REQ-AUTH §3.9）。
 *
 * GitHub 的配置是从 env 读的模块级常量，所以每个用例都要 `vi.stubEnv` + 重建
 * 模块图才能拿到一个「配了 GitHub」的 app —— 全局 test.env 里**故意不配**，
 * 好让别处那些「只有 Keycloak」的断言继续有意义。
 */

let stub: ReturnType<typeof stubGithubFetch>

beforeEach(async () => {
  await resetDb()
  stub = stubGithubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

type App = Hono<never>

/** 一个「配了 GitHub」的全新 app（Keycloak 也还在，两个都启用） */
async function githubApp(): Promise<App> {
  vi.stubEnv('GITHUB_CLIENT_ID', GITHUB_CLIENT_ID)
  vi.stubEnv('GITHUB_CLIENT_SECRET', GITHUB_CLIENT_SECRET)
  vi.resetModules()
  return (await import('../../app.ts')).app as unknown as App
}

/** 走一遍入口，把落库的授权请求和 oidc_tx cookie 一起拿回来 */
async function start(app: App, path: string, cookie?: string) {
  const res = await app.request(path, cookie ? { headers: { cookie } } : undefined)
  const txId = cookieValue(res, 'oidc_tx')
  const request = txId ? await prisma.authRequest.findUnique({ where: { id: txId } }) : null
  return { res, txId, request }
}

/** 拼一个从 GitHub 跳回来的回调 */
function callback(app: App, params: Record<string, string>, cookies: string[]) {
  const search = new URLSearchParams(params).toString()
  return app.request(`/api/auth/callback?${search}`, { headers: { cookie: cookies.join('; ') } })
}

/** 完整走一遍 GitHub 登录，返回回调响应 */
async function loginWithGithub(app: App, query = '') {
  const { txId, request } = await start(app, `/api/auth/login?provider=github${query}`)
  return callback(app, { code: 'gh-code', state: request?.state ?? '' }, [`oidc_tx=${txId}`])
}

/** 走到「等确认」为止：授权回来了，但还没绑 */
async function startLink(app: App, cookie: string, code = 'gh-code') {
  const { txId } = await start(app, '/api/auth/link/github', cookie)
  return callback(app, { code, state: (await current(txId)).state }, [
    `oidc_tx=${txId}`,
    cookie,
  ])
}

/** 授权 + 确认，一路绑完 */
async function linkGithub(app: App, cookie: string, code = 'gh-code') {
  await startLink(app, cookie, code)
  return app.request('/api/auth/link/confirm', { method: 'POST', headers: { cookie } })
}

describe('GET /api/auth/login?provider=github', () => {
  it('跳 GitHub 的授权页，带上 client_id / redirect_uri / state', async () => {
    const app = await githubApp()
    const { res, request } = await start(app, '/api/auth/login?provider=github')

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(GITHUB_AUTHORIZE_URL)
    expect(location.searchParams.get('client_id')).toBe(GITHUB_CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/api/auth/callback',
    )
    expect(location.searchParams.get('state')).toBe(request?.state)
    // GitHub 的 OAuth App 不支持 PKCE，别往上面挂没人看的参数
    expect(location.searchParams.get('code_challenge')).toBeNull()
  })

  it('授权请求上记着走的是哪个提供方 —— 回调只有一个地址，靠它分发', async () => {
    const app = await githubApp()
    const { request } = await start(app, '/api/auth/login?provider=github')
    expect(request?.provider).toBe('github')
  })

  it('没配 GitHub 时这个入口跳回登录页报错，不会把人送去一个空 client_id 的地址', async () => {
    // 不 stubEnv，用全局那份只有 Keycloak 的配置。
    // resetModules 是必须的：上一个用例已经建过一份「配了 GitHub」的模块图，
    // 直接 import 拿到的是那一份缓存，环境变量早就不作数了
    vi.resetModules()
    const { app } = await import('../../app.ts')
    const res = await app.request('/api/auth/login?provider=github')

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('没有启用')
  })

  it('/api/auth/config 把两个提供方都列出来', async () => {
    const app = await githubApp()
    const body = (await (await app.request('/api/auth/config')).json()) as {
      provider: string
      providers: { id: string }[]
    }

    expect(body.providers.map((p) => p.id)).toEqual(['keycloak', 'github'])
    // 不带 ?provider= 时仍然是 Keycloak，老书签的行为不变
    expect(body.provider).toBe('keycloak')
  })
})

describe('GitHub 登录', () => {
  it('第一次登录建号：User + 一条 UserIdentity + sid cookie', async () => {
    const app = await githubApp()
    const res = await loginWithGithub(app, '&redirect=/2048')

    expect(res.headers.get('location')).toBe('/2048')
    expect(cookieValue(res, 'sid')).toBeTruthy()

    const user = await prisma.user.findFirstOrThrow({ include: { identities: true } })
    expect(user).toMatchObject({
      issuer: GITHUB_ISSUER,
      subject: '4242',
      username: 'octocat',
      email: 'octo@example.com',
      name: 'Octo Cat',
    })
    expect(user.identities).toHaveLength(1)
    expect(user.identities[0]).toMatchObject({ provider: 'github', subject: '4242' })
  })

  it('会话上记着 provider，续期时才知道该问谁', async () => {
    const app = await githubApp()
    await loginWithGithub(app)

    const session = await prisma.session.findFirstOrThrow()
    expect(session.provider).toBe('github')
    // OAuth App 的 token 不会过期，也没有 refresh_token
    expect(session.refreshToken).toBeNull()
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000)
  })

  it('同一个 GitHub 账号再登一次还是同一个人，不会建出第二个号', async () => {
    const app = await githubApp()
    await loginWithGithub(app)
    await loginWithGithub(app)

    expect(await prisma.user.count()).toBe(1)
    expect(await prisma.userIdentity.count()).toBe(1)
  })

  it('token 端点回 200 但 body 里是 error → 不建会话（只看状态码会当成功）', async () => {
    const app = await githubApp()
    stub.token = {
      status: 200,
      body: { error: 'bad_verification_code', error_description: 'code 已经用过了' },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await loginWithGithub(app)

    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('code 已经用过了')
    expect(await prisma.session.count()).toBe(0)
    expect(await prisma.user.count()).toBe(0)
  })

  it('邮箱设为私密时（/user 的 email 是 null）去 /user/emails 取主邮箱', async () => {
    const app = await githubApp()
    stub.user = { status: 200, body: githubUser({ email: null }) }
    stub.emails = {
      status: 200,
      body: [
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: 'primary@example.com', primary: true, verified: true },
      ],
    }

    await loginWithGithub(app)

    expect((await prisma.user.findFirstOrThrow()).email).toBe('primary@example.com')
  })

  it('连 /user/emails 也拿不到邮箱时照样登得进来 —— 邮箱不是必填项', async () => {
    const app = await githubApp()
    stub.user = { status: 200, body: githubUser({ email: null }) }
    stub.emails = { status: 403, body: { message: 'no scope' } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await loginWithGithub(app)

    expect(cookieValue(res, 'sid')).toBeTruthy()
    expect((await prisma.user.findFirstOrThrow()).email).toBeNull()
  })

  it('邮箱和已有账号相同也不会登进那个账号 —— 身份只认 (provider, subject)', async () => {
    const app = await githubApp()
    // 先有一个 Keycloak 账号，邮箱和 GitHub 那边一模一样
    const existing = await identities.resolveLogin('keycloak', {
      subject: 'kc-1',
      issuer: 'https://keycloak.test/realms/test',
      username: 'alice',
      email: 'octo@example.com',
      name: 'Alice',
      avatarUrl: null,
      roles: ['admin'],
    })

    const res = await loginWithGithub(app)

    expect(cookieValue(res, 'sid')).toBeTruthy()
    expect(await prisma.user.count()).toBe(2)
    // 那个 Keycloak 账号原封不动，没被绑上一条 GitHub
    const rows = await prisma.userIdentity.findMany({ where: { userId: existing.id } })
    expect(rows.map((row) => row.provider)).toEqual(['keycloak'])
  })

  it('client_secret 走 body 而不是 URL', async () => {
    const app = await githubApp()
    await loginWithGithub(app)

    const call = stub.calls.find((one) => one.url.startsWith(GITHUB_TOKEN_URL))
    expect(call?.url).not.toContain(GITHUB_CLIENT_SECRET)
    expect(new URLSearchParams(call?.body ?? '').get('client_secret')).toBe(GITHUB_CLIENT_SECRET)
  })
})

describe('GET /api/auth/link/:provider', () => {
  it('未登录 → 401（关联是给已登录的人用的）', async () => {
    const app = await githubApp()
    const res = await app.request('/api/auth/link/github')
    expect(res.status).toBe(401)
  })

  it('没这个提供方 → 404', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()
    const res = await app.request('/api/auth/link/wechat', { headers: { cookie } })
    expect(res.status).toBe(404)
  })

  it('授权请求上带着 linkUserId —— 回调据此走关联而不是登录', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()
    const { request } = await start(app, '/api/auth/link/github', cookie)

    expect(request?.linkUserId).toBe(user.id)
    expect(request?.redirectTo).toBe('/settings')
  })

  it('授权回来时**还没绑上**，只落一条待确认的', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()

    const res = await startLink(app, cookie)

    // 干干净净回设置页，不带成功参数 —— 成功与否还没定
    expect(res.headers.get('location')).toBe('/settings')
    expect(cookieValue(res, 'sid')).toBeNull()
    // 一条 identity 都没多
    expect(await prisma.userIdentity.count({ where: { userId: user.id, provider: 'github' } })).toBe(
      0,
    )

    // 列表接口把它带出来，确认框才有东西显示
    const body = (await (
      await app.request('/api/auth/identities', { headers: { cookie } })
    ).json()) as { pending: { provider: string; username: string } | null }
    expect(body.pending).toMatchObject({ provider: 'github', username: 'octocat' })
  })

  it('确认之后才真的多一条 identity，不新建用户，会话也不变', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()

    const res = await linkGithub(app, cookie)

    expect(res.status).toBe(200)
    // 没有换会话：cookie 还是原来那个
    expect(cookieValue(res, 'sid')).toBeNull()
    expect(await prisma.user.count()).toBe(1)

    const rows = await prisma.userIdentity.findMany({ where: { userId: user.id } })
    expect(rows.map((row) => row.provider).sort()).toEqual(['github', 'keycloak'])
    // 主身份还是 Keycloak：关联不改档案归属
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.issuer).toBe(user.issuer)
    // 暂存用掉就没了
    expect(await prisma.pendingLink.count()).toBe(0)
  })

  it('放弃确认 → 什么都没发生，暂存也清了', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()
    await startLink(app, cookie)

    const res = await app.request('/api/auth/link/pending', {
      method: 'DELETE',
      headers: { cookie },
    })

    expect(res.status).toBe(204)
    expect(await prisma.pendingLink.count()).toBe(0)
    expect(await prisma.userIdentity.count({ where: { userId: user.id, provider: 'github' } })).toBe(
      0,
    )
  })

  it('没有待确认的还去确认 → 404，不会凭空绑出一条', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()

    const res = await app.request('/api/auth/link/confirm', { method: 'POST', headers: { cookie } })

    expect(res.status).toBe(404)
    expect(await prisma.userIdentity.count({ where: { provider: 'github' } })).toBe(0)
  })

  it('确认接口未登录 → 401', async () => {
    const app = await githubApp()
    const res = await app.request('/api/auth/link/confirm', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('待确认的关联只属于发起它的人，别人确认不到', async () => {
    const app = await githubApp()
    const mine = await signIn()
    await startLink(app, mine.cookie)

    const other = await signIn({ subject: 'other-user' })
    const res = await app.request('/api/auth/link/confirm', {
      method: 'POST',
      headers: { cookie: other.cookie },
    })

    expect(res.status).toBe(404)
    // 我那条还在，没被别人消费掉
    expect(await prisma.pendingLink.count({ where: { userId: mine.user.id } })).toBe(1)
  })

  it('再发起一次会顶掉上一条待确认的，不会攒出两条', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()

    await startLink(app, cookie, 'c1')
    stub.user = { status: 200, body: githubUser({ id: 9999, login: 'another' }) }
    await startLink(app, cookie, 'c2')

    expect(await prisma.pendingLink.count({ where: { userId: user.id } })).toBe(1)
    const row = await prisma.pendingLink.findFirstOrThrow()
    expect(row.subject).toBe('9999')
  })

  /**
   * 账号 A 已经绑了 GitHub 账号 G；B 登录后点「关联 GitHub」，而浏览器在 GitHub
   * 那边**还登着 G**（而且 OAuth App 之前已被 G 授权过，所以 GitHub 连确认页都不弹，
   * 直接带着 code 跳回来）。这一整趟对 B 来说是无感的，所以拒绝必须发生在服务端。
   */
  it('GitHub 那边登着的是别人已绑过的账号 → 拒绝，且什么都不留下', async () => {
    const app = await githubApp()
    // A：用 GitHub 账号 G 登进来，G 就此绑在 A 名下
    await loginWithGithub(app)
    const a = await prisma.user.findFirstOrThrow()

    // B：自己的账号，登录状态正常
    const { cookie, user: b } = await signIn({ subject: 'someone-else' })
    const { txId } = await start(app, '/api/auth/link/github', cookie)
    const res = await callback(app, { code: 'gh-code', state: (await current(txId)).state }, [
      `oidc_tx=${txId}`,
      cookie,
    ])

    const location = decodeURIComponent(res.headers.get('location') ?? '')
    expect(location).toContain('/settings?link_error=')
    expect(location).toContain('已经关联到另一个用户')

    // G 还在 A 名下，没被抢走；B 身上一条 github 都没多出来
    const github = await prisma.userIdentity.findFirstOrThrow({ where: { provider: 'github' } })
    expect(github.userId).toBe(a.id)
    expect(await prisma.userIdentity.count({ where: { userId: b.id, provider: 'github' } })).toBe(0)

    // B 的会话原样不动：没换 sid，也没被顺手登成 A
    expect(cookieValue(res, 'sid')).toBeNull()
    const session = await prisma.session.findFirstOrThrow({ where: { userId: b.id } })
    expect(session.userId).toBe(b.id)

    // 授权请求一次性消费掉了，没有残留可供重放
    expect(await prisma.authRequest.count()).toBe(0)
  })

  it('自己已经绑了一个 GitHub 账号时不能再绑第二个', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()
    await linkGithub(app, cookie, 'c1')

    // 换一个 GitHub 账号再来
    stub.user = { status: 200, body: githubUser({ id: 9999, login: 'another' }) }
    const res = await startLink(app, cookie, 'c2')

    // 预检就拦下了，连确认框都不该弹
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('请先解绑')
    expect(await prisma.pendingLink.count()).toBe(0)
    expect(await prisma.userIdentity.count()).toBe(2)
  })

  it('用户在 GitHub 上点了取消 → 回设置页而不是登录页', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()
    const { txId } = await start(app, '/api/auth/link/github', cookie)

    const res = await callback(app, { error: 'access_denied' }, [`oidc_tx=${txId}`, cookie])

    expect(res.headers.get('location')).toContain('/settings?link_error=')
  })
})

describe('GET /api/auth/identities', () => {
  it('未登录 → 401', async () => {
    const app = await githubApp()
    expect((await app.request('/api/auth/identities')).status).toBe(401)
  })

  it('存量用户（UserIdentity 表之前就在的人）读列表时补出主身份', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()
    expect(await prisma.userIdentity.count()).toBe(0)

    const body = (await (await app.request('/api/auth/identities', { headers: { cookie } })).json()) as {
      items: { provider: string; primary: boolean }[]
    }

    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ provider: 'keycloak', label: 'Keycloak', primary: true })
    // 真的落库了，不是只在响应里补
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(1)
  })
})

describe('DELETE /api/auth/identities/:id', () => {
  it('只剩一条时 409，绝不允许把自己锁在外面', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()
    const [only] = await list(app, cookie)

    const res = await app.request(`/api/auth/identities/${only?.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })

    expect(res.status).toBe(409)
    expect(await prisma.userIdentity.count()).toBe(1)
  })

  it('不是自己的那条 → 404', async () => {
    const app = await githubApp()
    const { cookie } = await signIn()
    await list(app, cookie)

    const other = await signIn({ subject: 'other-user' })
    await list(app, other.cookie)
    const [victim] = await list(app, other.cookie)

    const res = await app.request(`/api/auth/identities/${victim?.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })

    expect(res.status).toBe(404)
    expect(await prisma.userIdentity.count()).toBe(2)
  })

  it('解绑主身份 → 204，剩下的那条被提升为主身份', async () => {
    const app = await githubApp()
    const { cookie, user } = await signIn()
    await linkGithub(app, cookie)

    const primary = (await list(app, cookie)).find((row) => row.primary)
    const res = await app.request(`/api/auth/identities/${primary?.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })

    expect(res.status).toBe(204)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.issuer).toBe(GITHUB_ISSUER)
    expect(after.subject).toBe('4242')
    // 会话是我们自己发的，不跟着提供方走
    expect(await prisma.session.count()).toBe(1)
  })
})

/** 读一次授权请求（state 每次都是新的，不能写死） */
async function current(txId: string | null | undefined) {
  return prisma.authRequest.findUniqueOrThrow({ where: { id: txId ?? '' } })
}

async function list(app: App, cookie: string) {
  const res = await app.request('/api/auth/identities', { headers: { cookie } })
  const body = (await res.json()) as { items: { id: string; provider: string; primary: boolean }[] }
  return body.items
}
