import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../auth/session.ts'
import { authorizeCollab } from '../../auth/ws.ts'
import { createUser, resetDb } from '../helpers/db.ts'
import { idTokenClaims, stubOidcFetch, tokenResponse } from '../helpers/oidc.ts'
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
      tokens: tokenResponse({ expiresIn: 5, refreshToken: options.refreshToken }),
      claims: idTokenClaims(),
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
