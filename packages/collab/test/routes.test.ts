import { FlowDocStore } from '@learning/canvas'
import { FLOW_STATE_VECTOR_HEADER } from '@learning/contracts/collab'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COLLAB_LIMITS } from '../src/quota.js'
import { roomOf } from '../src/flow-persistence.js'
import { type Actor, addNodes, createFlow, createProject, describeOnBothDatabases, docWith, nodeIdsOf } from './helpers.js'

const OCTET = { 'content-type': 'application/octet-stream' }

describeOnBothDatabases('协同的 HTTP 接口', (ctx) => {
  const personalFlow = async (who: Actor) => createFlow(who, (await who.request('/api/projects/personal')).json<{ id: string }>().id)
  const push = (who: Actor, flowId: string, update: Uint8Array) => who.request(`/api/flows/${flowId}/doc`, { method: 'POST', headers: OCTET, body: update })
  const pull = (who: Actor, flowId: string, sv?: string) => who.request(`/api/flows/${flowId}/doc${sv ? `?sv=${encodeURIComponent(sv)}` : ''}`)

  afterEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  /** 从 `apps/server/test/routes/flow-doc.test.ts` 移植。重点是两条通道不许串台 */
  describe('/api/flows/:flowId/doc', () => {
    it('未登录 → 401', async () => {
      expect((await ctx.anonymous('/api/flows/x/doc')).status).toBe(401)
    })

    it('推上去的增量能原样拉回来，带基线的差量近乎为空', async () => {
      const alice = await ctx.actor()
      const flowId = await personalFlow(alice)

      const pushed = await push(alice, flowId, addNodes('n1', 'n2'))
      expect(pushed.status).toBe(200)
      const ack = pushed.json<{ stateVector: string; revision: number; noop: boolean }>()
      expect(ack).toMatchObject({ noop: false, revision: 1 })

      const pulled = await pull(alice, flowId)
      expect(pulled.headers['content-type']).toContain('application/octet-stream')
      expect(pulled.headers[FLOW_STATE_VECTOR_HEADER]).toBe(ack.stateVector)
      expect(nodeIdsOf(pulled.raw)).toEqual(['n1', 'n2'])

      const diff = await pull(alice, flowId, ack.stateVector)
      expect(nodeIdsOf(diff.raw)).toEqual([])
      await ctx.persistence.forget(roomOf(flowId))
    })

    it('项目画布走这条通道 → 409，内容一个字节都没进去', async () => {
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))

      const refused = await push(alice, flowId, addNodes('n1'))
      expect(refused.status).toBe(409)
      expect(refused.json()).toMatchObject({ error: 'Conflict' })
      expect((await pull(alice, flowId)).status).toBe(409)
    })

    it('不是成员 → 404，和画布不存在同一个口径', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const flowId = await personalFlow(alice)

      expect((await pull(bob, flowId)).status).toBe(404)
      expect((await push(bob, flowId, addNodes('n1'))).status).toBe(404)
      expect((await pull(alice, 'no-such-flow')).status).toBe(404)
    })

    it('请求体超过单条上限 → 413', async () => {
      const alice = await ctx.actor()
      const flowId = await personalFlow(alice)
      expect((await push(alice, flowId, new Uint8Array(COLLAB_LIMITS.message + 1))).status).toBe(413)
    })

    it('空请求体 → 400；不是二进制的请求体 → 400；sv 不合法 → 400', async () => {
      const alice = await ctx.actor()
      const flowId = await personalFlow(alice)

      expect((await push(alice, flowId, new Uint8Array(0))).status).toBe(400)
      expect((await alice.json(`/api/flows/${flowId}/doc`, 'POST', { a: 1 })).status).toBe(400)
      const bad = await pull(alice, flowId, '这不是-base64url!!')
      expect(bad.status).toBe(400)
      expect(bad.json()).toEqual({ error: 'sv 不是合法的状态向量' })
    })

    it('重复推同一段 → noop，revision 不涨', async () => {
      const alice = await ctx.actor()
      const flowId = await personalFlow(alice)
      const update = addNodes('n1')

      await push(alice, flowId, update)
      expect((await push(alice, flowId, update)).json()).toMatchObject({ noop: true, revision: 1 })
      await ctx.persistence.forget(roomOf(flowId))
    })
  })

  /** 从 `apps/server/test/routes/collab.test.ts` 移植。状态码本身就是结论 */
  describe('/api/collab', () => {
    it('未登录 → 401', async () => {
      expect((await ctx.anonymous('/api/collab/health')).status).toBe(401)
      expect((await ctx.anonymous('/api/collab/rooms')).status).toBe(401)
    })

    it('一切正常 → 200，并报出落库健康度的那几个数', async () => {
      const alice = await ctx.actor()
      const response = await alice.request('/api/collab/health')

      expect(response.status).toBe(200)
      expect(response.json()).toMatchObject({
        ok: true,
        pending: 0,
        owed: 0,
        store: { failed: expect.any(Number) as number },
        cluster: { ok: true },
        rooms: { total: 0 },
      })
      expect(response.json<{ instance: string }>().instance).toBeTruthy()
    })

    it('没有房间时报 0', async () => {
      const alice = await ctx.actor()
      const response = await alice.request('/api/collab/rooms')
      expect(response.status).toBe(200)
      expect(response.json()).toMatchObject({ totalRooms: 0, totalConnections: 0 })
    })

    it('欠着落库 → 503；补上之后回到 200，failed 留在响应里', async () => {
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const write = vi.spyOn(ctx.app.get(FlowDocStore, { strict: false }), 'compareAndWrite').mockRejectedValue(new Error('炸了'))
      await expect(ctx.persistence.store(roomOf(flowId), docWith(['n1']))).rejects.toThrow()

      const failing = await alice.request('/api/collab/health')
      expect(failing.status).toBe(503)
      expect(failing.json()).toMatchObject({ ok: false, owed: 1 })
      expect(failing.json<{ store: { failed: number } }>().store.failed).toBeGreaterThan(0)

      write.mockRestore()
      await ctx.persistence.retryFailed()
      const recovered = await alice.request('/api/collab/health')
      expect(recovered.status).toBe(200)
      expect(recovered.json()).toMatchObject({ ok: true, owed: 0 })
      expect(recovered.json<{ store: { failed: number } }>().store.failed).toBeGreaterThan(0)
      await ctx.persistence.forget(roomOf(flowId))
    })
  })
})
