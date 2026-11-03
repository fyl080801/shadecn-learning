import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DataAccess } from '@learning/data-access'
import { identiconUrl, LoginModule } from '@learning/session'
import { FakeBrowser, followAuthorize, startFakeIdp, type FakeIdp } from '@learning/session/testing'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { roomOf } from '../src/flow-persistence.js'
import { type Actor, assertTestDatabase, bootCollabApp, connect, createFlow, createProject, joinViaInvite, type TestClient } from './helpers.js'

const ORIGIN = 'http://app.test'
const TIMEOUT = { timeout: 10_000, interval: 20 }
const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

/**
 * 平台（有 `LoginModule`）登录，副本（只有 `SessionIdentityModule`，没有 `UserIdentity` 这张表的实体）上的 awareness 拿到正确的头像：头像只经 `User.avatarUrl` 过桥。
 * 真的跨进程结构要 Redis：设了 `PLATFORM_TEST_REDIS_URL` 时两个人连在不同副本上，否则连同一个副本。
 */
describe('协同副本上的头像', () => {
  const schema = 'collab_avatar_test'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-avatar-'))
  const databaseUrl = postgresUrl ? `${postgresUrl}?schema=${schema}` : `file:${path.join(dir, 'test.db')}`
  const cluster = redisUrl ? { cluster: { mode: 'redis', url: redisUrl } } : {}

  let idp: FakeIdp
  let platform: NestFastifyApplication
  let replicas: NestFastifyApplication[] = []
  let platformUrl: string
  const clients: TestClient[] = []

  const bootReplica = () => bootCollabApp(databaseUrl, { canvasApi: false, values: { ...cluster, database: { url: databaseUrl, schemaSync: 'off' } } })

  /** 走真的登录流程，拿到的 cookie 和浏览器一样 */
  async function loginAs(user: FakeIdp['user']): Promise<Actor> {
    const browser = new FakeBrowser(platformUrl, ORIGIN)
    idp.user = user
    const start = await browser.get('/api/auth/login?provider=oidc')
    await browser.get(await followAuthorize(start.headers.location as string))
    const cookie = `sid=${browser.cookies.get('sid')?.value}`
    const me = JSON.parse((await browser.get('/api/auth/me')).body) as { user: { id: string } }
    const request: Actor['request'] = async (url, init = {}) => {
      const res = await platform.inject({ method: (init.method ?? 'GET') as 'GET', url, headers: { ...init.headers, cookie }, payload: init.body as string | undefined })
      return { status: res.statusCode, headers: res.headers, text: res.body, raw: res.rawPayload, json: <T>() => JSON.parse(res.body) as T }
    }
    return {
      userId: me.user.id,
      cookie,
      request,
      json: (url, method, payload) => (payload === undefined ? request(url, { method }) : request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })),
    }
  }

  const open = (replica: NestFastifyApplication, room: string, actor: Actor) =>
    replica.getUrl().then((url) => {
      const client = connect(url.replace('http://', 'ws://'), room, actor.cookie)
      clients.push(client)
      return client
    })

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    if (postgresUrl) assertTestDatabase(postgresUrl)
    idp = await startFakeIdp()
    const auth = { auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId } }, server: { origins: [ORIGIN] } }
    // 平台不接协同入口，和 main-without-collab 一样。先于副本：副本不建表
    platform = await bootCollabApp(databaseUrl, { imports: [LoginModule], values: { ...cluster, ...auth } })
    platformUrl = await platform.getUrl()
    const first = await bootReplica()
    replicas = redisUrl ? [first, await bootReplica()] : [first]
  }, 60_000)

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy()
  })

  afterAll(async () => {
    for (const replica of replicas) await replica.close()
    if (postgresUrl) await platform?.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
    await platform?.close()
    await idp?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('没有 picture 的人是 identicon，有 picture 的人是 picture；客户端自报的压不过服务端', async () => {
    const alice = await loginAs({ sub: 'alice-avatar', preferred_username: 'alice', name: 'Alice' })
    const bob = await loginAs({ sub: 'bob-avatar', preferred_username: 'bob', name: 'Bob', picture: 'https://cdn.test/bob.png' })
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    await joinViaInvite(alice, projectId, bob)
    const room = roomOf(flowId)

    const a = await open(replicas[0], room, alice)
    const b = await open(replicas[replicas.length - 1], room, bob)
    await vi.waitFor(() => {
      expect(a.synced()).toBe(true)
      expect(b.synced()).toBe(true)
    }, TIMEOUT)

    a.provider.setAwarenessField('user', { id: 'forged', name: '冒名', avatarUrl: 'https://evil.test/x.png', color: '#111111' })
    b.provider.setAwarenessField('user', { id: 'forged', name: '冒名', avatarUrl: 'https://evil.test/y.png', color: '#222222' })

    await vi.waitFor(() => {
      const fromAlice = b.provider.awareness?.getStates().get(a.doc.clientID) as { user?: Record<string, unknown> } | undefined
      const fromBob = a.provider.awareness?.getStates().get(b.doc.clientID) as { user?: Record<string, unknown> } | undefined
      expect(fromAlice?.user).toMatchObject({ id: alice.userId, name: 'Alice', avatarUrl: identiconUrl(idp.issuer, 'alice-avatar') })
      expect(fromBob?.user).toMatchObject({ id: bob.userId, name: 'Bob', avatarUrl: 'https://cdn.test/bob.png' })
    }, TIMEOUT)
  }, 30_000)
})
