import http from 'node:http'
import net from 'node:net'
import { FlowDocStore, ProjectMember } from '@learning/canvas'
import { CLOSE_QUOTA_LOCKED, CLOSE_REVOKED, CLOSE_SUPERSEDED, CLOSE_UNAUTHORIZED, STORE_STATE_MESSAGE } from '@learning/contracts/collab'
import { nodesMap } from '@learning/contracts/flow-doc'
import { SessionService } from '@learning/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CollabAuth } from '../src/collab-auth.js'
import { CollabGateway } from '../src/collab-gateway.js'
import { CollabServer } from '../src/collab-server.js'
import { roomOf } from '../src/flow-persistence.js'
import { COLLAB_LIMITS, CollabQuota } from '../src/quota.js'
import { SYNC_MESSAGE_TYPES } from '../src/write-gate.js'
import { type Actor, connect, createFlow, createProject, describeOnBothDatabases, joinViaInvite, nodeIdsOf, nodeMap, type TestClient } from './helpers.js'

const TIMEOUT = { timeout: 8000, interval: 20 }

/** 真 `@hocuspocus/provider` + 真 WebSocket + 真端口。Hocuspocus 的防抖是 2 秒，等落库的用例因此各要两秒多 */
describeOnBothDatabases('真 provider', (ctx) => {
  const clients: TestClient[] = []
  const open = (room: string, cookie: string | null, options?: Parameters<typeof connect>[3]) => {
    const client = connect(ctx.wsUrl, room, cookie, options)
    clients.push(client)
    return client
  }
  const synced = (client: TestClient) => vi.waitFor(() => expect(client.synced()).toBe(true), TIMEOUT)
  const store = () => ctx.app.get(FlowDocStore, { strict: false })
  const hocuspocus = () => ctx.server.hocuspocus
  const saved = async (flowId: string) => nodeIdsOf((await store().read(flowId, { liveProject: false, legacy: false }))?.ydoc)

  async function room(members: Actor[] = []) {
    const alice = await ctx.actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    for (const member of members) await joinViaInvite(alice, projectId, member)
    return { alice, projectId, flowId, name: roomOf(flowId) }
  }

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy()
    vi.restoreAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  describe('同步', () => {
    it('两个账号同时编辑互相可见，人走光后内容和投影都在库里', async () => {
      const bob = await ctx.actor('bob')
      const { alice, flowId, name } = await room([bob])
      const a = open(name, alice.cookie)
      const b = open(name, bob.cookie)
      await synced(a)
      await synced(b)

      nodesMap(a.doc).set('from-alice', nodeMap('甲'))
      nodesMap(b.doc).set('from-bob', nodeMap('乙'))

      await vi.waitFor(() => {
        expect([...nodesMap(a.doc).keys()].sort()).toEqual(['from-alice', 'from-bob'])
        expect([...nodesMap(b.doc).keys()].sort()).toEqual(['from-alice', 'from-bob'])
      }, TIMEOUT)

      a.destroy()
      b.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.has(name)).toBe(false), TIMEOUT)

      expect(await saved(flowId)).toEqual(['from-alice', 'from-bob'])
      const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ nodeCount: number }>()
      expect(detail.nodeCount).toBe(2)
    })

    it('持续在线也按防抖落库：不用等散场', async () => {
      const { alice, flowId, name } = await room()
      const a = open(name, alice.cookie)
      await synced(a)

      nodesMap(a.doc).set('n1', nodeMap())

      await vi.waitFor(async () => expect(await saved(flowId)).toEqual(['n1']), TIMEOUT)
    })

    it('重新打开：服务端重新读库，新客户端拿到旧内容', async () => {
      const { alice, name } = await room()
      const a = open(name, alice.cookie)
      await synced(a)
      nodesMap(a.doc).set('n1', nodeMap())
      await vi.waitFor(() => expect(hocuspocus().documents.get(name)?.getMap('nodes').has('n1')).toBe(true), TIMEOUT)
      a.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.has(name)).toBe(false), TIMEOUT)

      const again = open(name, alice.cookie)
      await synced(again)
      await vi.waitFor(() => expect([...nodesMap(again.doc).keys()]).toEqual(['n1']), TIMEOUT)
    })

    it('/api/collab/rooms 报得出在线的房间和连接', async () => {
      const { alice, flowId, name } = await room()
      const a = open(name, alice.cookie)
      await synced(a)

      const stats = (await alice.request('/api/collab/rooms')).json<{ totalConnections: number; rooms: { name: string; connections: number; flowId: string }[] }>()
      expect(stats.rooms).toContainEqual(expect.objectContaining({ name, connections: 1, flowId }))
    })
  })

  describe('awareness', () => {
    it('客户端自报的身份被服务端那份覆盖，对方看到的是真身份', async () => {
      const bob = await ctx.actor('bob')
      const { alice, name } = await room([bob])
      const a = open(name, alice.cookie)
      const b = open(name, bob.cookie)
      await synced(a)
      await synced(b)

      a.provider.setAwarenessField('user', { id: 'u-fake', name: '冒名顶替', color: '#123456' })

      await vi.waitFor(() => {
        const state = b.provider.awareness?.getStates().get(a.doc.clientID) as { user?: Record<string, unknown> } | undefined
        expect(state?.user).toMatchObject({ id: alice.userId, name: 'alice', color: '#123456' })
      }, TIMEOUT)
    })

    it('个人画布的房间：awareness 整帧丢弃，同一个人的另一条连接看不到「协作者」', async () => {
      const alice = await ctx.actor('alice')
      const space = (await alice.request('/api/projects/personal')).json<{ id: string }>()
      const name = roomOf(await createFlow(alice, space.id))
      const a = open(name, alice.cookie)
      await synced(a)

      a.provider.setAwarenessField('user', { id: 'x', name: 'x' })
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(hocuspocus().documents.get(name)?.awareness.getStates().size).toBe(0)
    })
  })

  describe('握手被拒：没有关闭事件，原因在 reason 上', () => {
    it('没有会话 → Unauthorized，内容一个字节都拿不到', async () => {
      const { alice, flowId, name } = await room()
      const owner = open(name, alice.cookie)
      await synced(owner)
      nodesMap(owner.doc).set('secret', nodeMap())
      await vi.waitFor(async () => expect(await saved(flowId)).toEqual(['secret']), TIMEOUT)

      const anonymous = open(name, null)
      await vi.waitFor(() => expect(anonymous.denied).toEqual([CLOSE_UNAUTHORIZED.reason]), TIMEOUT)
      expect(nodesMap(anonymous.doc).size).toBe(0)
      expect(anonymous.closes).toEqual([])
    })

    it('登着但不是成员 → permission-revoked，不是 Unauthorized', async () => {
      const stranger = await ctx.actor('stranger')
      const { name } = await room()

      const client = open(name, stranger.cookie)
      await vi.waitFor(() => expect(client.denied).toEqual([CLOSE_REVOKED.reason]), TIMEOUT)
    })

    it('画布不存在 → permission-revoked', async () => {
      const alice = await ctx.actor('alice')
      const client = open(roomOf('no-such-flow'), alice.cookie)
      await vi.waitFor(() => expect(client.denied).toEqual([CLOSE_REVOKED.reason]), TIMEOUT)
      expect(hocuspocus().documents.has(roomOf('no-such-flow'))).toBe(false)
    })
  })

  describe('踢人要关 socket', () => {
    const closedWith = (client: TestClient, event: { code: number; reason: string }) =>
      vi.waitFor(() => {
        // reason 是跨两条腿的判据；code 只在真正的关闭帧上，所以它在就说明 socket 真关了
        expect(client.closes).toContainEqual(expect.objectContaining({ reason: event.reason }))
        expect(client.closes.map((close) => close.code)).toContain(event.code)
      }, TIMEOUT)

    it('移除成员：接口返回时对方已经被踢（4403 关闭帧），之后也连不回来', async () => {
      const bob = await ctx.actor('bob')
      const { alice, projectId, name } = await room([bob])
      const a = open(name, alice.cookie)
      const b = open(name, bob.cookie)
      await synced(a)
      await synced(b)
      expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(2)

      const res = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
      expect(res.status).toBe(204)

      // revoke 被 await 了：204 回来的时候这个人已经不在房间里
      expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(1)
      await closedWith(b, CLOSE_REVOKED)
      // provider 自动重连，握手被同一套检查拒回来
      await vi.waitFor(() => expect(b.denied).toContain(CLOSE_REVOKED.reason), TIMEOUT)
      expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(1)
    })

    it('删画布：房间里的人同样被踢', async () => {
      const { alice, flowId, name } = await room()
      const a = open(name, alice.cookie)
      await synced(a)

      expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
      await closedWith(a, CLOSE_REVOKED)
    })

    it('会话没了：复验关的是 4401，不是 4403 —— 一个空闲超时的人不该被告知「你已不是成员」', async () => {
      const bob = await ctx.actor('bob')
      const { name } = await room([bob])
      const b = open(name, bob.cookie)
      await synced(b)

      // 登出、过期、被管理员清掉都是这个样子：这条 cookie 对不上任何会话了
      await ctx.app.get(SessionService).deleteByToken(bob.cookie.slice('sid='.length))
      await ctx.server.revalidateConnections()

      await closedWith(b, CLOSE_UNAUTHORIZED)
    })

    it('同一个人开第二个窗口：旧窗口收到 4409，新窗口留着', async () => {
      const { alice, name } = await room()
      const first = open(name, alice.cookie)
      await synced(first)
      const second = open(name, alice.cookie)
      await synced(second)

      await closedWith(first, CLOSE_SUPERSEDED)
      expect(second.closes).toEqual([])
      expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(1)
      // 真实的前端收到后会自己 disconnect（classifyClose），这里照做，否则两边互相踢
      first.provider.disconnect()
    })
  })

  describe('写闸门', () => {
    it('权限没了但连接还没被踢：写帧进不了文档，连接随后被关', async () => {
      const bob = await ctx.actor('bob')
      const { alice, projectId, name } = await room([bob])
      const a = open(name, alice.cookie)
      const b = open(name, bob.cookie)
      await synced(a)
      await synced(b)

      // 直接改库，不走撤权信号：造出「判定还在缓存、连接还在线」的窗口。作废缓存相当于 TTL 到期
      await ctx.dataAccess.em().nativeDelete(ProjectMember, { project: projectId, user: bob.userId })
      ;(ctx.server as unknown as { writeGate: { clear(): void } }).writeGate.clear()

      nodesMap(b.doc).set('from-removed', nodeMap())

      await vi.waitFor(() => expect(b.closes.map((close) => close.code)).toContain(CLOSE_REVOKED.code), TIMEOUT)
      expect(hocuspocus().documents.get(name)?.getMap('nodes').has('from-removed')).toBe(false)
      expect(nodesMap(a.doc).has('from-removed')).toBe(false)
    })

    it('SyncStep1 是读，不过闸门：拦了重连的同步握手都做不成；写帧才查，查不过置只读不抛错', async () => {
      const authorize = vi.spyOn(ctx.app.get(CollabAuth, { strict: false }), 'authorize').mockResolvedValue({ ok: false, reason: 'forbidden' })
      ;(ctx.server as unknown as { writeGate: { clear(): void } }).writeGate.clear()
      const connection = { socketId: 'hook-test', readOnly: false, request: new Request('http://x'), close: vi.fn(), webSocket: { close: vi.fn() } }
      const beforeSync = hocuspocus().configuration.beforeSync as (data: unknown) => Promise<void>

      await beforeSync({ type: SYNC_MESSAGE_TYPES.step1, connection, documentName: 'flow:x' })
      expect(authorize).not.toHaveBeenCalled()
      expect(connection.readOnly).toBe(false)

      await expect(beforeSync({ type: SYNC_MESSAGE_TYPES.update, connection, documentName: 'flow:x' })).resolves.toBeUndefined()
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(connection.readOnly).toBe(true)
      await vi.waitFor(() => expect(connection.webSocket.close).toHaveBeenCalledWith(CLOSE_REVOKED.code, CLOSE_REVOKED.reason))
    })
  })

  describe('配额：拒绝不抛错', () => {
    it('超限的单条消息：只拒这一条，不断连，内容没进文档', async () => {
      const { alice, name } = await room()
      const a = open(name, alice.cookie)
      await synced(a)
      const warn = vi.spyOn(console, 'warn')

      const big = new Y.Map<unknown>()
      big.set('blob', 'x'.repeat(COLLAB_LIMITS.message + 1024))
      nodesMap(a.doc).set('big', big)

      await vi.waitFor(() => expect(warn.mock.calls.some((call) => String(call[0]).includes('超限消息'))).toBe(true), TIMEOUT)
      expect(hocuspocus().documents.get(name)?.getMap('nodes').has('big')).toBe(false)
      expect(a.closes).toEqual([])
      expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(1)
    })

    it('顶到硬限：锁写并清场，所有人收到 4413', async () => {
      const bob = await ctx.actor('bob')
      const { alice, name } = await room([bob])
      const a = open(name, alice.cookie)
      const b = open(name, bob.cookie)
      await synced(a)
      await synced(b)
      vi.spyOn(ctx.app.get(CollabQuota, { strict: false }), 'check').mockReturnValue('测试造的硬限')

      nodesMap(a.doc).set('n1', nodeMap())

      for (const client of [a, b]) {
        await vi.waitFor(() => expect(client.closes.map((close) => close.code)).toContain(CLOSE_QUOTA_LOCKED.code), TIMEOUT)
      }
    })
  })

  describe('落库失败不丢内容', () => {
    it('存不进去：房间收到通知、人走了文档留在内存、新来的人拿得到内容；恢复后补进库，欠账归零', async () => {
      const { alice, flowId, name } = await room()
      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))
      const a = open(name, alice.cookie)
      await synced(a)

      nodesMap(a.doc).set('precious', nodeMap())

      // 等防抖走到落库：房间收到「存不进去」
      await vi.waitFor(() => expect(a.stateless).toContain(JSON.stringify({ type: STORE_STATE_MESSAGE, ok: false })), TIMEOUT)
      expect(ctx.persistence.isStoreFailing(name)).toBe(true)
      expect(await saved(flowId)).toEqual([])

      // 最后一个人走了：卸载的钩子也抛错，文档留在内存
      a.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(0), TIMEOUT)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(hocuspocus().documents.has(name)).toBe(true)

      // 新连接：内容从内存来（库里还是空的），并补发一次通知
      const again = open(name, alice.cookie)
      await synced(again)
      await vi.waitFor(() => expect([...nodesMap(again.doc).keys()]).toEqual(['precious']), TIMEOUT)
      await vi.waitFor(() => expect(again.stateless).toContain(JSON.stringify({ type: STORE_STATE_MESSAGE, ok: false })), TIMEOUT)

      // 数据库恢复：定时器做的事
      write.mockRestore()
      await ctx.persistence.retryFailed()

      expect(ctx.persistence.failedStoreCount()).toBe(0)
      expect(await saved(flowId)).toEqual(['precious'])
      await vi.waitFor(() => expect(again.stateless).toContain(JSON.stringify({ type: STORE_STATE_MESSAGE, ok: true })), TIMEOUT)
    })

    it('补上欠账之后：没人的房间从内存卸载，还有人的留着', async () => {
      const { alice, flowId, name } = await room()
      const write = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))
      const a = open(name, alice.cookie)
      await synced(a)
      nodesMap(a.doc).set('precious', nodeMap())
      await vi.waitFor(() => expect(ctx.persistence.isStoreFailing(name)).toBe(true), TIMEOUT)

      // 库还没恢复：重试失败，文档不能卸载
      a.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(0), TIMEOUT)
      const again = open(name, alice.cookie)
      await synced(again)
      await ctx.app.get(CollabServer, { strict: false }).retryFailedStores()
      expect(hocuspocus().documents.has(name)).toBe(true)

      // 恢复时还有人在：内容进库，房间留着
      write.mockRestore()
      await ctx.app.get(CollabServer, { strict: false }).retryFailedStores()
      expect(ctx.persistence.failedStoreCount()).toBe(0)
      expect(hocuspocus().documents.has(name)).toBe(true)
      again.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.has(name)).toBe(false), TIMEOUT)
      expect(await saved(flowId)).toEqual(['precious'])

      // 恢复时已经没人：只有 retryFailedStores 能把它请出内存
      const failing = vi.spyOn(store(), 'compareAndWrite').mockRejectedValue(new Error('数据库炸了'))
      const b = open(name, alice.cookie)
      await synced(b)
      nodesMap(b.doc).set('second', nodeMap())
      await vi.waitFor(() => expect(ctx.persistence.isStoreFailing(name)).toBe(true), TIMEOUT)
      b.destroy()
      await vi.waitFor(() => expect(hocuspocus().documents.get(name)?.getConnectionsCount()).toBe(0), TIMEOUT)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(hocuspocus().documents.has(name)).toBe(true)
      failing.mockRestore()
      await ctx.app.get(CollabServer, { strict: false }).retryFailedStores()
      expect(hocuspocus().documents.has(name)).toBe(false)
      expect(await saved(flowId)).toEqual(expect.arrayContaining(['precious', 'second']))
    })
  })

  describe('upgrade 入口', () => {
    /** 发一个裸的 upgrade 请求，看它是 101、别的状态码，还是连接被掐 */
    function upgrade(path: string, headers: Record<string, string> = {}) {
      const { hostname, port } = new URL(ctx.baseUrl)
      return new Promise<{ status: number } | { destroyed: true }>((resolve) => {
        const req = http.request({
          hostname,
          port,
          path,
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
        })
        req.on('upgrade', (res, socket) => {
          socket.destroy()
          resolve({ status: res.statusCode ?? 0 })
        })
        req.on('response', (res) => {
          res.destroy()
          resolve({ status: res.statusCode ?? 0 })
        })
        req.on('error', () => resolve({ destroyed: true }))
        req.end()
      })
    }

    it('别的站点发起的握手 → 403，进不到 onConnect', async () => {
      expect(await upgrade('/ws/collaboration', { origin: 'https://evil.example' })).toEqual({ status: 403 })

      // 带着受害者的 cookie 从别的站点连：这正是 CSWSH。认证根本轮不到它
      const alice = await ctx.actor('alice')
      const flowId = await createFlow(alice, await createProject(alice))
      const authorize = vi.spyOn(ctx.app.get(CollabAuth, { strict: false }), 'authorize')
      const attacker = open(roomOf(flowId), alice.cookie, { origin: 'https://evil.example' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(attacker.synced()).toBe(false)
      expect(authorize).not.toHaveBeenCalled()
      expect(hocuspocus().documents.has(roomOf(flowId))).toBe(false)
    })

    it('沙箱 iframe 的 Origin: null → 403', async () => {
      expect(await upgrade('/ws/collaboration', { origin: 'null' })).toEqual({ status: 403 })
    })

    it('没有 Origin（脚本）、Origin 和 Host 同源 → 101', async () => {
      expect(await upgrade('/ws/collaboration')).toEqual({ status: 101 })
      expect(await upgrade('/ws/collaboration', { origin: ctx.baseUrl })).toEqual({ status: 101 })
      expect(await upgrade('/ws/collaboration?x=1', { origin: ctx.baseUrl })).toEqual({ status: 101 })
    })

    it('别的路径没有别的监听者 → 销毁连接，不挂着', async () => {
      expect(await upgrade('/ws/other')).toEqual({ destroyed: true })
    })

    it('别的路径有别的监听者（Vite HMR）→ 不管，交给它', async () => {
      const server = ctx.app.getHttpServer() as http.Server
      const hmr = (req: http.IncomingMessage, socket: { end(data: string): void }) => {
        if (req.url === '/hmr') socket.end('HTTP/1.1 418 Teapot\r\nConnection: close\r\n\r\n')
      }
      server.on('upgrade', hmr)
      try {
        expect(await upgrade('/hmr')).toEqual({ status: 418 })
      } finally {
        server.off('upgrade', hmr)
      }
    })

    it('别的监听者不接也不关的连接，退出时由网关收掉', async () => {
      const server = ctx.app.getHttpServer() as http.Server
      let handed!: () => void
      const received = new Promise<void>((resolve) => (handed = resolve))
      const ignore = () => handed()
      server.on('upgrade', ignore)
      const { hostname, port } = new URL(ctx.baseUrl)
      const client = net.connect(Number(port), hostname, () => {
        client.write('GET /ws/other HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
      client.on('error', () => undefined)
      try {
        await received
        ctx.app.get(CollabGateway, { strict: false }).beforeApplicationShutdown()
        await closed
      } finally {
        server.off('upgrade', ignore)
      }
    })

    it('停止接入之后 → 503，已有连接不受影响', async () => {
      const gateway = ctx.app.get(CollabGateway, { strict: false }) as unknown as { accepting: boolean }
      gateway.accepting = false
      try {
        expect(await upgrade('/ws/collaboration')).toEqual({ status: 503 })
      } finally {
        gateway.accepting = true
      }
    })
  })
})
