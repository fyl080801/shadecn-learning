import { ProjectsService } from '@learning/canvas'
import { nodesMap } from '@learning/contracts/flow-doc'
import { startFakeIdp } from '@learning/session/testing'
import { SessionService, UserService } from '@learning/session'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabAuth, isAllowedCollabOrigin } from '../src/collab-auth.js'
import { CollabServer } from '../src/collab-server.js'
import { roomOf } from '../src/flow-persistence.js'
import { bootCollabApp, connect, createActor, createFlow, createProject, describeOnBothDatabases, joinViaInvite, nodeMap } from './helpers.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * WebSocket 握手鉴权。从 `apps/server/test/collab/authorize.test.ts` 移植。
 * 房间即资源：画布房间必须是项目成员才进得去，否则任何登录用户都能连进别人项目的画布。
 */
describeOnBothDatabases('authorize', (ctx) => {
  const auth = () => ctx.app.get(CollabAuth, { strict: false })
  const allows = async (cookie: string | undefined, room: string, options?: { refresh?: boolean }) => (await auth().authorize(cookie, room, options)).ok

  describe('进房资格', () => {
    it('没有 cookie → 拒绝', async () => {
      expect(await allows(undefined, 'demo')).toBe(false)
    })

    it('cookie 是伪造的 → 拒绝', async () => {
      expect(await allows('sid=not-a-real-token', 'demo')).toBe(false)
    })

    it('登录用户可以进演示房间', async () => {
      const alice = await ctx.actor('alice')
      expect(await allows(alice.cookie, 'demo')).toBe(true)
    })

    it('项目成员可以进自己画布的房间', async () => {
      const alice = await ctx.actor('alice')
      const flowId = await createFlow(alice, await createProject(alice))
      expect(await allows(alice.cookie, `flow:${flowId}`)).toBe(true)
    })

    it('放行时带回**服务端认定的身份** —— awareness 改写都用它', async () => {
      const alice = await ctx.actor('alice')
      const flowId = await createFlow(alice, await createProject(alice))
      expect(await auth().authorize(alice.cookie, `flow:${flowId}`)).toEqual({ ok: true, identity: { id: alice.userId, name: 'alice', avatarUrl: null } })
    })

    it('加入项目之后就进得去了', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(false)
      await joinViaInvite(alice, projectId, bob)
      expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(true)
    })

    it('画布不存在 → 拒绝（不给探测画布是否存在的机会）', async () => {
      const alice = await ctx.actor('alice')
      expect(await allows(alice.cookie, 'flow:不存在的画布')).toBe(false)
    })
  })

  describe('拒绝的原因：会话没了重新登录就能回来，不是成员则登了也白登，不能合并', () => {
    it('没有会话 → unauthorized', async () => {
      expect(await auth().authorize(undefined, 'demo')).toEqual({ ok: false, reason: 'unauthorized' })
      expect(await auth().authorize('sid=伪造的', 'demo')).toEqual({ ok: false, reason: 'unauthorized' })
    })

    it('登着但不是项目成员 → forbidden（不是 unauthorized）', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const flowId = await createFlow(alice, await createProject(alice))
      expect(await auth().authorize(bob.cookie, `flow:${flowId}`)).toEqual({ ok: false, reason: 'forbidden' })
    })

    it('画布不存在也算 forbidden —— 登录态没问题，是这个房间进不去', async () => {
      const alice = await ctx.actor('alice')
      expect(await auth().authorize(alice.cookie, 'flow:不存在的画布')).toEqual({ ok: false, reason: 'forbidden' })
    })

    it('被移出项目之后就变成 forbidden —— 复验据此把在线连接踢下线', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      await joinViaInvite(alice, projectId, bob)
      expect(await allows(bob.cookie, `flow:${flowId}`)).toBe(true)

      await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })

      expect(await auth().authorize(bob.cookie, `flow:${flowId}`, { refresh: false })).toEqual({ ok: false, reason: 'forbidden' })
    })
  })

  describe('个人画布的房间（从 routes/flow-doc.test.ts 移植）', () => {
    it('所有者本人放行并带 personal 标记，其他人 forbidden', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const space = (await alice.request('/api/projects/personal')).json<{ id: string }>()
      const soloId = await createFlow(alice, space.id)

      expect(await auth().authorize(alice.cookie, `flow:${soloId}`)).toMatchObject({ ok: true, identity: { id: alice.userId }, personal: true })
      expect(await auth().authorize(bob.cookie, `flow:${soloId}`)).toEqual({ ok: false, reason: 'forbidden' })
    })

    it('个人画布删掉之后，所有者也进不了它的房间', async () => {
      const alice = await ctx.actor('alice')
      const space = (await alice.request('/api/projects/personal')).json<{ id: string }>()
      const soloId = await createFlow(alice, space.id)
      expect((await alice.request(`/api/flows/${soloId}`, { method: 'DELETE' })).status).toBe(204)

      expect(await auth().authorize(alice.cookie, `flow:${soloId}`)).toEqual({ ok: false, reason: 'forbidden' })
    })
  })
})

/** CSWSH 那道闸：upgrade 走裸的 `server.on('upgrade')`，这一道必须自己判 */
describe('isAllowedCollabOrigin', () => {
  const ORIGIN = 'https://a.example.com'
  const allowed = [ORIGIN, 'https://b.example.com']
  const host = 'a.example.com'

  it('没有 Origin → 放行：非浏览器客户端没有这个头，而浏览器一定带', () => {
    expect(isAllowedCollabOrigin(undefined, host, allowed)).toBe(true)
  })

  it('Origin 在白名单 → 放行，大小写和默认端口归一化后比较', () => {
    expect(isAllowedCollabOrigin(ORIGIN, host, allowed)).toBe(true)
    expect(isAllowedCollabOrigin('HTTPS://A.EXAMPLE.COM:443', 'internal.svc', allowed)).toBe(true)
  })

  it('别的站点发起的握手 → 拒绝，这正是要挡的那一下', () => {
    expect(isAllowedCollabOrigin('https://evil.example', host, allowed)).toBe(false)
    expect(isAllowedCollabOrigin(`${ORIGIN}.evil.example`, host, allowed)).toBe(false)
  })

  it('Origin 的 host 和请求的 Host 一致 → 放行：白名单没配对时也不该断线', () => {
    expect(isAllowedCollabOrigin('http://localhost:3000', 'localhost:3000', allowed)).toBe(true)
    // 端口不同就是不同源
    expect(isAllowedCollabOrigin('http://localhost:5173', 'localhost:3000', allowed)).toBe(false)
  })

  it('Origin 不是合法 URL（沙箱 iframe 的 "null"、被改过的头）→ 拒绝', () => {
    expect(isAllowedCollabOrigin('null', host, allowed)).toBe(false)
    expect(isAllowedCollabOrigin('不是个 URL', host, allowed)).toBe(false)
  })

  it('白名单里的另一个域名 → 放行；名单外的同名邻居还是拒绝', () => {
    // 反代把 Host 改成了内网名字，这条只能靠名单认出来
    expect(isAllowedCollabOrigin('https://b.example.com', 'internal.svc', allowed)).toBe(true)
    expect(isAllowedCollabOrigin('https://b.example.com.evil.example', 'internal.svc', allowed)).toBe(false)
  })
})

/** 定期复验和写闸门走同一个函数，但**不许续期**：续了就等于「标签页开着就永不登出」 */
describe('复验模式（refresh: false）', () => {
  let dir: string
  let idp: Awaited<ReturnType<typeof startFakeIdp>>
  let app: Awaited<ReturnType<typeof bootCollabApp>>

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-refresh-'))
    idp = await startFakeIdp()
    app = await bootCollabApp(`file:${path.join(dir, 'test.db')}`, { values: { auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } } } })
  })

  afterAll(async () => {
    await app.close()
    await idp.stop()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    idp.tokenCalls.length = 0
  })

  /** access_token 马上过期、refresh_token 还在（或没有）的会话 */
  async function staleSession(refreshToken: string | null) {
    const user = await app.get(UserService).findOrCreate({ issuer: idp.issuer, subject: `stale-${Math.random()}` })
    const token = await app.get(SessionService).create({
      userId: user.id,
      provider: 'oidc',
      tokens: { accessToken: 'old', refreshToken, idToken: null, expiresAt: new Date(Date.now() + 5000), refreshExpiresAt: null, sessionState: null },
    })
    return `sid=${token}`
  }
  const allows = async (cookie: string, options?: { refresh?: boolean }) => (await app.get(CollabAuth, { strict: false }).authorize(cookie, 'demo', options)).ok

  it('access_token 快过期时，复验不去换新的 —— 长连接不给会话续命', async () => {
    expect(await allows(await staleSession('refresh-1'), { refresh: false })).toBe(true)
    expect(idp.tokenCalls).toHaveLength(0)
  })

  it('同一个会话走握手时照常续期 —— 握手本身就是一次真实请求', async () => {
    expect(await allows(await staleSession('refresh-2'))).toBe(true)
    expect(idp.tokenCalls).toHaveLength(1)
  })

  /** 上面是函数本身，这条是接线：长连接上的复验和写闸门真的传了 `refresh: false` */
  it('真连接：握手续一次；之后的复验和写帧都不再续，access_token 再旧也一样', async () => {
    // 换回来的 token 也活不过续期窗口，所以每次走带续期的路都会打到 token 端点
    idp.accessTokenTtl = 5
    const alice = await createActor(app)
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    const cookie = await staleSession('refresh-3')
    const session = await app.get(SessionService).load(cookie.slice('sid='.length), { refresh: false })
    const { token } = (await alice.request(`/api/projects/${projectId}/invite`)).json<{ token: string }>()
    await app.get(ProjectsService, { strict: false }).acceptInvite(token, session?.user.id ?? '')

    const client = connect((await app.getUrl()).replace('http://', 'ws://'), roomOf(flowId), cookie)
    await vi.waitFor(() => expect(client.synced()).toBe(true), { timeout: 5000 })
    expect(idp.tokenCalls).toHaveLength(1)

    const server = app.get(CollabServer, { strict: false })
    await server.revalidateConnections()
    expect(idp.tokenCalls).toHaveLength(1)

    // 判定缓存已被复验作废，这一笔要真的查一次
    nodesMap(client.doc).set('n1', nodeMap())
    await vi.waitFor(() => expect(server.hocuspocus.documents.get(roomOf(flowId))?.getMap('nodes').has('n1')).toBe(true), { timeout: 5000 })
    expect(idp.tokenCalls).toHaveLength(1)

    client.destroy()
  })

  it('refresh token 也没了 → 复验判定失效，连接会被踢下线', async () => {
    expect(await allows(await staleSession(null), { refresh: false })).toBe(false)
    expect(idp.tokenCalls).toHaveLength(0)
  })
})
