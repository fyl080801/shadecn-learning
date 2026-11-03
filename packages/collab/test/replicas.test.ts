import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FlowDocStore } from '@learning/canvas'
import { CLOSE_QUOTA_LOCKED, CLOSE_REVOKED, CLOSE_SUPERSEDED } from '@learning/contracts/collab'
import { nodesMap } from '@learning/contracts/flow-doc'
import { DataAccess } from '@learning/data-access'
import { Redis } from '@hocuspocus/extension-redis'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CollabServer } from '../src/collab-server.js'
import { FlowPersistence, roomOf } from '../src/flow-persistence.js'
import { CollabQuota } from '../src/quota.js'
import { type Actor, assertTestDatabase, bootCollabApp, connect, createActor, createFlow, createProject, joinViaInvite, nodeIdsOf, nodeMap, type TestClient } from './helpers.js'

const TIMEOUT = { timeout: 10_000, interval: 20 }
const REVOCATION_DEADLINE_MS = 3_000
/** 轮询到点之后的复验（查库 + 关连接）和本机调度的余量 */
const REVOCATION_MARGIN_MS = 700

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

interface Replica {
  app: NestFastifyApplication
  server: CollabServer
  persistence: FlowPersistence
  wsUrl: string
  extension: Redis
  /** 走这个副本的 HTTP 入口 */
  request(actor: Actor, url: string): Promise<{ status: number; body: Record<string, unknown> }>
}

/**
 * 和部署同样的形状：一个不接协同的平台（`apply`，有画布 REST）+ 两个副本（`off`，只有协同入口），共用数据库和真 Redis。
 * 没设 `PLATFORM_TEST_REDIS_URL` 整组跳过。库默认 SQLite 临时文件，设了 `PLATFORM_TEST_DATABASE_URL` 走 PostgreSQL 的独立 schema。
 */
describe.skipIf(!redisUrl)('两个副本（真 Redis）', () => {
  const schema = 'collab_replicas_test'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-replicas-'))
  const databaseUrl = postgresUrl ? `${postgresUrl}?schema=${schema}` : `file:${path.join(dir, 'test.db')}`
  const cluster = { mode: 'redis', url: redisUrl }

  let platform: NestFastifyApplication
  let r1: Replica
  let r2: Replica
  const clients: TestClient[] = []

  async function bootReplica(): Promise<Replica> {
    const app = await bootCollabApp(databaseUrl, { canvasApi: false, values: { cluster, database: { url: databaseUrl, schemaSync: 'off' } } })
    const server = app.get(CollabServer, { strict: false })
    const baseUrl = await app.getUrl()
    return {
      app,
      server,
      persistence: app.get(FlowPersistence, { strict: false }),
      wsUrl: baseUrl.replace('http://', 'ws://'),
      extension: server.hocuspocus.configuration.extensions.find((extension): extension is Redis => extension instanceof Redis) as Redis,
      request: async (actor, url) => {
        const res = await app.inject({ method: 'GET', url, headers: { cookie: actor.cookie } })
        return { status: res.statusCode, body: JSON.parse(res.body) }
      },
    }
  }

  const open = (replica: Replica, room: string, actor: Actor, options?: Parameters<typeof connect>[3]) => {
    const client = connect(replica.wsUrl, room, actor.cookie, options)
    clients.push(client)
    return client
  }
  const synced = (client: TestClient) => vi.waitFor(() => expect(client.synced()).toBe(true), TIMEOUT)
  const nodeKeys = (client: TestClient) => [...nodesMap(client.doc).keys()].sort()
  const saved = async (flowId: string) => nodeIdsOf((await platform.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: false, legacy: false }))?.ydoc)

  async function room(members: Actor[] = []) {
    const alice = await createActor(platform, 'alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    for (const member of members) await joinViaInvite(alice, projectId, member)
    return { alice, projectId, flowId, name: roomOf(flowId) }
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    if (postgresUrl) assertTestDatabase(postgresUrl)
    // imports: [] = 平台不接协同入口，和 main-without-collab 一样。先于副本：副本不建表
    platform = await bootCollabApp(databaseUrl, { imports: [], values: { cluster } })
    r1 = await bootReplica()
    r2 = await bootReplica()
  }, 60_000)

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy()
  })

  afterAll(async () => {
    await r1?.app.close()
    await r2?.app.close()
    if (postgresUrl) await platform?.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
    await platform?.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('内容', () => {
    it('两个账号连在不同副本上，互相看得见，身份和光标也跨得过去', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)

      nodesMap(a.doc).set('from-alice', nodeMap('甲'))
      nodesMap(b.doc).set('from-bob', nodeMap('乙'))
      await vi.waitFor(() => {
        expect(nodeKeys(a)).toEqual(['from-alice', 'from-bob'])
        expect(nodeKeys(b)).toEqual(['from-alice', 'from-bob'])
      }, TIMEOUT)

      expect(r1.server.stats().rooms).toContainEqual(expect.objectContaining({ name, connections: 1 }))
      expect(r2.server.stats().rooms).toContainEqual(expect.objectContaining({ name, connections: 1 }))

      a.provider.setAwarenessField('user', { id: 'u-fake', name: '冒名顶替', color: '#123456' })
      await vi.waitFor(() => {
        const state = b.provider.awareness?.getStates().get(a.doc.clientID) as { user?: Record<string, unknown> } | undefined
        expect(state?.user).toMatchObject({ id: alice.userId, name: 'alice', color: '#123456' })
      }, TIMEOUT)
    }, 20_000)

    it('没落库的内容也跨副本：另一个副本第一次打开房间，等到的是对方内存里的那份', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, flowId, name } = await room([bob])
      const a = open(r1, name, alice)
      await synced(a)
      nodesMap(a.doc).set('in-memory', nodeMap())
      await vi.waitFor(() => expect(r1.server.hocuspocus.documents.get(name)?.getMap('nodes').has('in-memory')).toBe(true), TIMEOUT)
      // 防抖 2 秒还没到：库里没有，下面只可能是从 r1 同步来的
      expect(await saved(flowId)).toEqual([])

      const b = open(r2, name, bob)
      await synced(b)
      await vi.waitFor(() => expect(nodeKeys(b)).toEqual(['in-memory']), TIMEOUT)
    }, 20_000)

    it('人走光之后两个副本都散场，内容和投影都在库里', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, flowId, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)
      nodesMap(a.doc).set('n1', nodeMap())
      nodesMap(b.doc).set('n2', nodeMap())
      await vi.waitFor(() => expect(nodeKeys(a)).toEqual(['n1', 'n2']), TIMEOUT)

      a.destroy()
      b.destroy()
      await vi.waitFor(() => {
        expect(r1.server.hocuspocus.documents.has(name)).toBe(false)
        expect(r2.server.hocuspocus.documents.has(name)).toBe(false)
      }, TIMEOUT)

      expect(await saved(flowId)).toEqual(['n1', 'n2'])
      expect((await alice.request(`/api/flows/${flowId}`)).json<{ nodeCount: number }>().nodeCount).toBe(2)
    }, 20_000)
  })

  describe('撤权', () => {
    it(`平台上移除成员，连在副本上的人 ${REVOCATION_DEADLINE_MS} 毫秒内被踢，别人不受影响`, async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, projectId, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)
      const closesBefore = a.closes.length

      const started = Date.now()
      expect((await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })).status).toBe(204)

      await vi.waitFor(() => expect(b.closes.map((close) => close.code)).toContain(CLOSE_REVOKED.code), { timeout: REVOCATION_DEADLINE_MS + REVOCATION_MARGIN_MS, interval: 20 })
      expect(Date.now() - started).toBeLessThanOrEqual(REVOCATION_DEADLINE_MS + REVOCATION_MARGIN_MS)
      expect(a.closes.length).toBe(closesBefore)
      expect(r1.server.stats().rooms).toContainEqual(expect.objectContaining({ name, connections: 1 }))
    }, 20_000)
  })

  describe('单连接互斥', () => {
    it('同一个人在另一个副本开新窗口：新的留下，旧的收到 4409，而且不会抢回来', async () => {
      const { alice, name } = await room()
      const oldWindow = open(r1, name, alice)
      // 前端收到 4409 自己停下，不然 provider 的重连会把新窗口顶掉
      oldWindow.provider.on('close', ({ event }: { event: { reason: string } }) => {
        if (event.reason === CLOSE_SUPERSEDED.reason) oldWindow.provider.disconnect()
      })
      await synced(oldWindow)
      const newWindow = open(r2, name, alice)
      await synced(newWindow)

      await vi.waitFor(() => expect(oldWindow.closes.map((close) => close.code)).toContain(CLOSE_SUPERSEDED.code), TIMEOUT)
      // 再过一轮巡检，新窗口还在
      await new Promise((resolve) => setTimeout(resolve, 3500))
      expect(newWindow.closes).toEqual([])
      expect(r2.server.stats().rooms).toContainEqual(expect.objectContaining({ name, connections: 1 }))
    }, 25_000)
  })

  describe('复制画布', () => {
    it('平台经总线问到副本：拿到两个副本上还没落库的内容，投影的计数也是新的', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, flowId, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)
      nodesMap(a.doc).set('from-alice', nodeMap())
      nodesMap(b.doc).set('from-bob', nodeMap())
      await vi.waitFor(() => expect(nodeKeys(a)).toEqual(['from-alice', 'from-bob']), TIMEOUT)
      expect(await saved(flowId)).toEqual([])

      const res = await alice.request(`/api/flows/${flowId}/duplicate`, { method: 'POST' })
      expect(res.status).toBe(201)
      const copy = res.json<{ id: string; nodeCount: number }>()

      expect(copy.nodeCount).toBe(2)
      expect(await saved(copy.id)).toEqual(['from-alice', 'from-bob'])
    }, 20_000)
  })

  describe('两个副本同时落库', () => {
    /** 每个副本的 `/api/collab/health`：判定 200，什么都不欠，没有失败 */
    async function expectHealthy(actor: Actor) {
      for (const replica of [r1, r2]) {
        const { status, body } = await replica.request(actor, '/api/collab/health')
        expect(status).toBe(200)
        expect(body).toMatchObject({ ok: true, owed: 0, pending: 0, store: expect.objectContaining({ failed: 0 }) })
      }
    }

    it('并发写同一行：读 → 合并 → CAS 不丢内容，撞车不算失败', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, flowId, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)

      for (let round = 0; round < 5; round += 1) {
        nodesMap(a.doc).set(`a${round}`, nodeMap())
        nodesMap(b.doc).set(`b${round}`, nodeMap())
        const doc1 = r1.server.hocuspocus.documents.get(name)
        const doc2 = r2.server.hocuspocus.documents.get(name)
        await vi.waitFor(() => {
          expect(doc1?.getMap('nodes').has(`a${round}`)).toBe(true)
          expect(doc2?.getMap('nodes').has(`b${round}`)).toBe(true)
        }, TIMEOUT)
        // 不等 pub/sub：两份文档此刻可能分叉，正是 CAS 只能证明「没人插队」、合并才保证超集的情况
        await Promise.all([r1.persistence.store(name, doc1 as never, { projection: true }), r2.persistence.store(name, doc2 as never, { projection: true })])
      }

      const expected = [0, 1, 2, 3, 4].flatMap((round) => [`a${round}`, `b${round}`]).sort()
      expect(await saved(flowId)).toEqual(expected)
      await expectHealthy(alice)
    }, 30_000)

    it('redlock 没抢到：这一轮被跳过，不记失败、不欠账，health 不误报，散场时内容照样进库', async () => {
      const { alice, flowId, name } = await room()
      const a = open(r2, name, alice)
      await synced(a)
      nodesMap(a.doc).set('skipped', nodeMap())
      const doc = await vi.waitFor(() => {
        const document = r2.server.hocuspocus.documents.get(name)
        expect(document?.getMap('nodes').has('skipped')).toBe(true)
        return document as NonNullable<typeof document>
      }, TIMEOUT)

      // r1 占着这把锁：确定性地造出「撞 redlock」，不靠两边防抖恰好同一刻到点
      await r1.extension.onStoreDocument({ documentName: name } as never)
      const before = r2.persistence.storeStats()
      await r2.server.hocuspocus.storeDocumentHooks(doc, { instance: r2.server.hocuspocus, clientsCount: 1, document: doc, documentName: name, lastContext: {}, lastTransactionOrigin: null } as never, true)
      expect(r2.persistence.storeStats()).toEqual(before)
      expect(await saved(flowId)).toEqual([])
      await expectHealthy(alice)

      await r1.extension.afterStoreDocument({ documentName: name, lastTransactionOrigin: null } as never)
      a.destroy()
      await vi.waitFor(() => expect(r2.server.hocuspocus.documents.has(name)).toBe(false), TIMEOUT)
      expect(await saved(flowId)).toEqual(['skipped'])
      await expectHealthy(alice)
    }, 25_000)
  })

  describe('落库失败', () => {
    it('不占着 redlock：别的副本接下来的落库不会被跳过', async () => {
      const { alice, name } = await room()
      const a = open(r2, name, alice)
      await synced(a)
      nodesMap(a.doc).set('n1', nodeMap())
      const failing = vi.spyOn(r2.app.get(FlowDocStore, { strict: false }), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))
      await vi.waitFor(() => expect(r2.persistence.isStoreFailing(name)).toBe(true), TIMEOUT)
      failing.mockRestore()

      // 锁还占着的话这里抛 SkipFurtherHooksError
      await r1.extension.onStoreDocument({ documentName: name } as never)
      await r1.extension.afterStoreDocument({ documentName: name, lastTransactionOrigin: null } as never)
      await r2.persistence.retryFailed()
    }, 20_000)
  })

  describe('Redis 连不上', () => {
    it('不抢锁、直接落库：内容不只留在内存里', async () => {
      const { alice, flowId, name } = await room()
      const a = open(r2, name, alice)
      await synced(a)
      nodesMap(a.doc).set('during-outage', nodeMap())
      const doc = await vi.waitFor(() => {
        const document = r2.server.hocuspocus.documents.get(name)
        expect(document?.getMap('nodes').has('during-outage')).toBe(true)
        return document as NonNullable<typeof document>
      }, TIMEOUT)

      // 这把锁被占着：还去抢的话这一轮就被跳过了，所以内容进库只可能是没抢锁
      await r1.extension.onStoreDocument({ documentName: name } as never)
      const pub = r2.extension.pub as unknown as { status: string }
      const realStatus = pub.status
      pub.status = 'reconnecting'
      try {
        await r2.server.hocuspocus.storeDocumentHooks(doc, { instance: r2.server.hocuspocus, clientsCount: 1, document: doc, documentName: name, lastContext: {}, lastTransactionOrigin: null } as never, true)
      } finally {
        pub.status = realStatus
        await r1.extension.afterStoreDocument({ documentName: name, lastTransactionOrigin: null } as never)
      }

      expect(await saved(flowId)).toEqual(['during-outage'])
    }, 20_000)
  })

  describe('redis 转发来的更新', () => {
    const countOf = (replica: Replica) => (replica.server as unknown as { window: { updates: number } }).window.updates

    it('按条计数只算收到更新的那个副本', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)
      const [before1, before2] = [countOf(r1), countOf(r2)]

      nodesMap(a.doc).set('counted', nodeMap())
      await vi.waitFor(() => expect(nodeKeys(b)).toEqual(['counted']), TIMEOUT)

      expect(countOf(r1)).toBe(before1 + 1)
      expect(countOf(r2)).toBe(before2)
    }, 20_000)

    it('配额不跳过：另一个副本量出顶到硬限，它那边的人同样被请出去', async () => {
      const bob = await createActor(platform, 'bob')
      const { alice, name } = await room([bob])
      const a = open(r1, name, alice)
      const b = open(r2, name, bob)
      await synced(a)
      await synced(b)
      const check = vi.spyOn(r2.app.get(CollabQuota, { strict: false }), 'check').mockReturnValue('测试：顶到硬限')

      try {
        nodesMap(a.doc).set('heavy', nodeMap())
        await vi.waitFor(() => expect(b.closes.map((close) => close.code)).toContain(CLOSE_QUOTA_LOCKED.code), TIMEOUT)
      } finally {
        check.mockRestore()
      }
    }, 20_000)
  })

  describe('一个副本退出', () => {
    it('内存里的内容落了库，同一个客户端接到另一个副本后内容和光标都还在，总线的登记也撤了', async () => {
      const r3 = await bootReplica()
      const bob = await createActor(platform, 'bob')
      const { alice, flowId, name } = await room([bob])
      const shared = connect(r3.wsUrl, name, alice.cookie)
      const watcher = open(r2, name, bob)
      await synced(shared)
      await synced(watcher)
      nodesMap(shared.doc).set('before-exit', nodeMap())
      shared.provider.setAwarenessField('user', { name: 'x' })
      await vi.waitFor(() => expect(nodeKeys(watcher)).toEqual(['before-exit']), TIMEOUT)

      await r3.app.close()
      // close 返回之前房间已经散场（断开钩子放掉了登记），扩展的 Redis 连接也关了
      expect(r3.server.hocuspocus.documents.size).toBe(0)
      expect(r3.extension.pub.status).toBe('end')
      expect(r3.extension.sub.status).toBe('end')
      shared.destroy()
      expect(await saved(flowId)).toEqual(['before-exit'])

      // 退出之后复制画布不再白等它（等的话要到 5 秒超时）
      const started = Date.now()
      expect((await alice.request(`/api/flows/${flowId}/duplicate`, { method: 'POST' })).status).toBe(201)
      expect(Date.now() - started).toBeLessThan(2000)

      // 同一个 Y.Doc = 同一个 clientID：登记要已经放掉，否则光标被当成冒名、丢到登记过期
      const moved = open(r1, name, alice, { doc: shared.doc })
      await synced(moved)
      moved.provider.setAwarenessField('user', { name: 'x' })
      await vi.waitFor(() => {
        const state = watcher.provider.awareness?.getStates().get(shared.doc.clientID) as { user?: Record<string, unknown> } | undefined
        expect(state?.user).toMatchObject({ id: alice.userId })
      }, TIMEOUT)
      expect(nodeKeys(moved)).toEqual(['before-exit'])
    }, 30_000)
  })
})
