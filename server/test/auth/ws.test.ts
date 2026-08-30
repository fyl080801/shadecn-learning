import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../auth/session.ts'
import { appOrigin } from '../../config.ts'
import { authorizeCollab, isAllowedCollabOrigin } from '../../auth/ws.ts'
import { createUser, resetDb } from '../helpers/db.ts'
import { providerTokens, stubOidcFetch } from '../helpers/oidc.ts'
import { actor, createFlow, createProject, joinViaInvite } from '../helpers/project.ts'

/**
 * WebSocket 握手鉴权。
 *
 * 房间即资源：画布房间（`flow:<id>`）必须是项目成员才进得去，
 * 否则任何登录用户都能连进别人项目的画布，看见在场的人和他们的光标。
 */

/** 放行了没有 —— 放行时还会带回是谁，见下面单独的用例 */
async function allows(
  cookie: string | undefined,
  room: string,
  options?: { refresh?: boolean },
) {
  return (await authorizeCollab(cookie, room, options)).ok
}

describe('authorizeCollab', () => {
  beforeEach(resetDb)

  it('没有 cookie → 拒绝', async () => {
    expect(await allows(undefined, 'demo')).toBe(false)
  })

  it('cookie 是伪造的 → 拒绝', async () => {
    expect(await allows('sid=not-a-real-token', 'demo')).toBe(false)
  })

  it('登录用户可以进演示房间', async () => {
    const alice = await actor('alice')
    expect(await allows(alice.cookie, 'demo')).toBe(true)
  })

  it('项目成员可以进自己画布的房间', async () => {
    const alice = await actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect(await allows(alice.cookie, `flow:${flowId}`)).toBe(true)
  })

  it('放行时带回**服务端认定的身份** —— 审计的 actorId 和 awareness 改写都用它', async () => {
    const alice = await actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect(await authorizeCollab(alice.cookie, `flow:${flowId}`)).toEqual({
      ok: true,
      identity: { id: alice.userId, name: 'alice', avatarUrl: null },
    })
  })

  it('加入项目之后就进得去了', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(false)

    await joinViaInvite(alice, projectId, bob)
    expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(true)
  })

  it('画布不存在 → 拒绝（不给探测画布是否存在的机会）', async () => {
    const alice = await actor('alice')
    expect(await allows(alice.cookie, 'flow:不存在的画布')).toBe(false)
  })
})

/**
 * 拒绝要说清是哪一种，因为出路完全不同：会话没了重新登录就能回来，
 * 不是成员则登了也白登。混作一谈的后果是给用户错误的指引 ——
 * 一个只看不编辑、会话空闲超时的人会被告知「你已不是这个项目的成员」。
 */
describe('拒绝的原因', () => {
  beforeEach(resetDb)

  it('没有会话 → unauthorized', async () => {
    expect(await authorizeCollab(undefined, 'demo')).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    expect(await authorizeCollab('sid=伪造的', 'demo')).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
  })

  it('登着但不是项目成员 → forbidden（不是 unauthorized）', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const flowId = await createFlow(alice, await createProject(alice))

    expect(await authorizeCollab(bob.cookie, `flow:${flowId}`)).toEqual({
      ok: false,
      reason: 'forbidden',
    })
  })

  it('画布不存在也算 forbidden —— 登录态没问题，是这个房间进不去', async () => {
    const alice = await actor('alice')
    expect(await authorizeCollab(alice.cookie, 'flow:不存在的画布')).toEqual({
      ok: false,
      reason: 'forbidden',
    })
  })

  it('被移出项目之后就变成 forbidden —— 复验据此把在线连接踢下线', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    await joinViaInvite(alice, projectId, bob)

    expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(true)

    await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })

    expect(await authorizeCollab(bob.cookie, `flow:${flowId}`, { refresh: false })).toEqual({
      ok: false,
      reason: 'forbidden',
    })
  })
})

/**
 * CSWSH（跨站 WebSocket 劫持）那道闸。
 *
 * WebSocket 不受同源策略保护：别的站点也能连过来，而 cookie 会被浏览器照常带上。
 * HTTP 那边有 CORS，但 upgrade 走的是裸的 `server.on('upgrade')`，Hono 的中间件
 * 一个都不经过，所以这一道必须自己判。
 */
describe('isAllowedCollabOrigin', () => {
  const host = new URL(appOrigin).host

  it('没有 Origin → 放行：非浏览器客户端（探针、脚本）没有这个头，而浏览器一定带', () => {
    expect(isAllowedCollabOrigin(undefined, host)).toBe(true)
  })

  it('Origin 就是 APP_ORIGIN → 放行', () => {
    expect(isAllowedCollabOrigin(appOrigin, host)).toBe(true)
  })

  it('别的站点发起的握手 → 拒绝，这正是要挡的那一下', () => {
    expect(isAllowedCollabOrigin('https://evil.example', host)).toBe(false)
    // 前缀像、其实是别人的域名
    expect(isAllowedCollabOrigin(`${appOrigin}.evil.example`, host)).toBe(false)
  })

  it('Origin 的 host 和请求的 Host 一致 → 放行：APP_ORIGIN 没配对时也不该断线', () => {
    // dev 下 APP_ORIGIN 默认是 127.0.0.1，人却从 localhost 打开
    expect(isAllowedCollabOrigin('http://localhost:3000', 'localhost:3000')).toBe(true)
    // 端口不同就是不同源，不能放
    expect(isAllowedCollabOrigin('http://localhost:5173', 'localhost:3000')).toBe(false)
  })

  it('Origin 不是合法 URL（沙箱 iframe 的 "null"、被改过的头）→ 拒绝', () => {
    expect(isAllowedCollabOrigin('null', host)).toBe(false)
    expect(isAllowedCollabOrigin('不是个 URL', host)).toBe(false)
  })

  it('APP_ORIGINS 里的另一个域名 → 放行；名单外的同名邻居还是拒绝', async () => {
    // 白名单是模块加载时算出来的常量，换一份 env 就得重新 import 一次
    vi.resetModules()
    vi.stubEnv('APP_ORIGINS', 'https://b.example.com')
    const ws = await import('../../auth/ws.ts')

    // 反代把 Host 改成了内网名字，这条只能靠名单认出来
    expect(ws.isAllowedCollabOrigin('https://b.example.com', 'internal.svc')).toBe(true)
    expect(ws.isAllowedCollabOrigin('https://b.example.com.evil.example', 'internal.svc')).toBe(
      false,
    )
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})

/**
 * 定期复验（`collab/hocuspocus.ts` 的 `revalidateConnections`）走的是同一个函数，
 * 但**不许续期**：那趟检查背后没有用户动作，续了就等于「标签页开着就永不登出」。
 * 会话该由真实的 HTTP 请求养着 —— 编辑触发的那次视图状态 PATCH 就是干这个的。
 */
describe('复验模式（refresh: false）', () => {
  beforeEach(resetDb)
  afterEach(() => vi.unstubAllGlobals())

  /** 造一个 access_token 马上过期、但 refresh_token 还在的会话 */
  async function staleSession(options: { refreshToken?: string | null } = {}) {
    const user = await createUser({ subject: `stale-${Math.random()}` })
    const token = await createSession({
      user,
      // refreshToken: null 就是「连 refresh token 都没有」，别在这里被 ?? 兜回默认值
      provider: 'keycloak',
      tokens: providerTokens({ expiresIn: 5, refreshToken: options.refreshToken }),
    })
    return { user, cookie: `sid=${token}` }
  }

  it('access_token 快过期时，复验不去换新的 —— 长连接不给会话续命', async () => {
    const stub = stubOidcFetch()
    const { cookie } = await staleSession()

    expect(await allows(cookie, 'demo', { refresh: false })).toBe(true)
    expect(stub.tokenCalls()).toBe(0)
  })

  it('同一个会话走握手时照常续期 —— 握手本身就是一次真实请求', async () => {
    const stub = stubOidcFetch()
    const { cookie } = await staleSession()

    expect(await allows(cookie, 'demo')).toBe(true)
    expect(stub.tokenCalls()).toBe(1)
  })

  it('refresh token 也没了 → 复验判定失效，连接会被踢下线', async () => {
    stubOidcFetch()
    const { cookie } = await staleSession({ refreshToken: null })

    expect(await allows(cookie, 'demo', { refresh: false })).toBe(false)
  })
})
