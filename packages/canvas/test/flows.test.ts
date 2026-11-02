import { emptyGraph, type FlowGraph } from '@learning/contracts/flow-graph'
import { describe, expect, it } from 'vitest'
import { Flow, FlowUserState } from '../src/entities.js'
import { type Actor, createFlow, createProject, describeOnBothDatabases, joinViaInvite } from './helpers.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describeOnBothDatabases('画布接口', (ctx) => {
  describe('GET /api/projects/:id/flows', () => {
    it('列表响应里没有 graph / ydoc，字段和现有接口一致', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      await createFlow(alice, projectId)

      const body = (await alice.request(`/api/projects/${projectId}/flows`)).json<{ items: Record<string, unknown>[] }>()
      expect(body.items).toHaveLength(1)
      expect(Object.keys(body.items[0] as object).sort()).toEqual(
        ['createdAt', 'createdById', 'description', 'edgeCount', 'id', 'mode', 'name', 'nodeCount', 'projectId', 'revision', 'status', 'tags', 'thumbnail', 'updatedAt'].sort(),
      )
      expect(body.items[0]?.createdAt).toMatch(ISO)
    })

    it('分页与关键字过滤', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      await createFlow(alice, projectId, '订单流程')
      await createFlow(alice, projectId, '退货流程')
      await createFlow(alice, projectId, '结算')

      expect((await alice.request(`/api/projects/${projectId}/flows?page=1&pageSize=2`)).json()).toMatchObject({ total: 3, totalPages: 2 })
      expect((await alice.request(`/api/projects/${projectId}/flows?keyword=${encodeURIComponent('流程')}`)).json()).toMatchObject({ total: 2 })
    })

    it('排序和状态过滤', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      await createFlow(alice, projectId, 'b')
      const published = await createFlow(alice, projectId, 'a')
      await alice.json(`/api/flows/${published}`, 'PATCH', { status: 'published' })

      const names = async (query: string) =>
        (await alice.request(`/api/projects/${projectId}/flows?${query}`)).json<{ items: { name: string }[] }>().items.map((row) => row.name)
      expect(await names('sort=name:asc')).toEqual(['a', 'b'])
      expect(await names('sort=name:desc')).toEqual(['b', 'a'])
      expect(await names('status=published')).toEqual(['a'])
    })

    it('非法的 sort / status / pageSize → 400', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const sort = await alice.request(`/api/projects/${projectId}/flows?sort=size:asc`)
      expect(sort.status).toBe(400)
      expect(sort.json()).toEqual({ error: 'sort 只支持 updatedAt / createdAt / name 加 :asc|:desc' })
      const status = await alice.request(`/api/projects/${projectId}/flows?status=unknown`)
      expect(status.status).toBe(400)
      expect(status.json()).toEqual({ error: 'status 只能是 draft / published / archived' })
      expect((await alice.request(`/api/projects/${projectId}/flows?pageSize=101`)).status).toBe(400)
    })

    it('软删的画布不再出现', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })
      expect((await alice.request(`/api/projects/${projectId}/flows`)).json()).toMatchObject({ total: 0 })
    })
  })

  describe('POST /api/projects/:id/flows', () => {
    it('建出来是空图，带 userState，revision 从 0 起', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const res = await alice.json(`/api/projects/${projectId}/flows`, 'POST', { name: '  画布  ', description: '说明' })
      expect(res.status).toBe(201)
      expect(res.json()).toMatchObject({
        projectId,
        mode: 'collab',
        name: '画布',
        description: '说明',
        status: 'draft',
        tags: [],
        thumbnail: null,
        nodeCount: 0,
        edgeCount: 0,
        revision: 0,
        createdById: alice.userId,
        graph: emptyGraph(),
        userState: {},
      })
    })

    it('name 不合法 → 400；非成员 → 404', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      expect((await alice.json(`/api/projects/${projectId}/flows`, 'POST', { name: '' })).json()).toEqual({ error: 'name 不能为空' })
      expect((await bob.json(`/api/projects/${projectId}/flows`, 'POST', { name: 'x' })).status).toBe(404)
    })

    it('member 也能建画布', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      expect((await bob.json(`/api/projects/${projectId}/flows`, 'POST', { name: 'x' })).status).toBe(201)
    })
  })

  describe('画布的访问权来自项目成员身份', () => {
    it('另一个项目的成员访问 → 404', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const aProject = await createProject(alice, 'A')
      const flowId = await createFlow(alice, aProject)
      await createProject(bob, 'B')

      const read = await bob.request(`/api/flows/${flowId}`)
      expect(read.status).toBe(404)
      expect(read.json()).toEqual({ error: 'Not Found', message: '画布不存在' })
      expect((await bob.json(`/api/flows/${flowId}`, 'PATCH', { name: 'x' })).status).toBe(404)
      expect((await bob.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(404)
      expect((await bob.json(`/api/flows/${flowId}/duplicate`, 'POST')).status).toBe(404)
    })

    it('同项目的 member 能读能写（成员之间平权，跟谁建的无关）', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)

      expect((await bob.request(`/api/flows/${flowId}`)).status).toBe(200)
      expect((await bob.json(`/api/flows/${flowId}`, 'PATCH', { name: 'bob 改的' })).status).toBe(200)
    })

    it('被移出项目后立刻访问不到画布', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)

      await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
      expect((await bob.request(`/api/flows/${flowId}`)).status).toBe(404)
    })

    it('项目或画布软删后都是 404', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const first = await createFlow(alice, projectId)
      const second = await createFlow(alice, projectId)

      await alice.request(`/api/flows/${first}`, { method: 'DELETE' })
      expect((await alice.request(`/api/flows/${first}`)).status).toBe(404)

      await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })
      expect((await alice.request(`/api/flows/${second}`)).status).toBe(404)
    })

    it('未登录 → 401', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      expect((await ctx.anonymous(`/api/flows/${flowId}`)).status).toBe(401)
    })
  })

  describe('PATCH /api/flows/:id', () => {
    it('改元数据：只动带来的字段，响应没有 graph，updatedAt 前进', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId, '原名')
      const before = (await alice.request(`/api/flows/${flowId}`)).json<{ updatedAt: string }>()
      await new Promise((resolve) => setTimeout(resolve, 5))

      const res = await alice.json(`/api/flows/${flowId}`, 'PATCH', { status: 'archived', tags: ['甲', '乙'] })
      expect(res.status).toBe(200)
      const body = res.json<{ updatedAt: string }>()
      expect(body).toMatchObject({ name: '原名', status: 'archived', tags: ['甲', '乙'], revision: 0 })
      expect(body).not.toHaveProperty('graph')
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime())
    })

    it.each([
      [{ name: 1 }, 'name 必须是字符串'],
      [{ description: 1 }, 'description 必须是字符串或 null'],
      [{ status: 'x' }, 'status 只能是 draft / published / archived'],
      [{ tags: 'x' }, 'tags 必须是字符串数组'],
      [{ tags: [1] }, 'tags 必须是字符串数组'],
    ])('校验 %j → 400', async (patch, error) => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      const res = await alice.json(`/api/flows/${flowId}`, 'PATCH', patch)
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error })
    })
  })

  describe('DELETE /api/flows/:id', () => {
    it('软删：204，行还在，别的画布不受影响', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)
      const other = await createFlow(alice, projectId)

      const res = await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect((await ctx.dataAccess.em().findOneOrFail(Flow, flowId)).deletedAt).toBeInstanceOf(Date)
      expect((await alice.request(`/api/flows/${other}`)).status).toBe(200)
    })
  })

  describe('PATCH /api/flows/:id/user-state', () => {
    const userStateOf = async (who: Actor, flowId: string) => (await who.request(`/api/flows/${flowId}`)).json<{ userState: Record<string, unknown> }>().userState

    it('存下来的视口只回给存它的人，别人看到的是自己的', async () => {
      const alice = await ctx.actor()
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)
      const flowId = await createFlow(alice, projectId)

      const res = await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 10, y: 20, zoom: 1.5 } })
      expect(res.status).toBe(204)

      expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 10, y: 20, zoom: 1.5 } })
      // bob 还没存过：拿到空对象，由前端回落到快照里那份兜底视口
      expect(await userStateOf(bob, flowId)).toEqual({})

      await bob.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: -5, y: 0, zoom: 0.5 } })
      expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 10, y: 20, zoom: 1.5 } })
      expect(await userStateOf(bob, flowId)).toEqual({ viewport: { x: -5, y: 0, zoom: 0.5 } })
    })

    it('再存一次是覆盖，一个人一张画布只有一行', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 1, y: 1, zoom: 1 } })
      await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 2, y: 2, zoom: 2 } })

      expect(await userStateOf(alice, flowId)).toEqual({ viewport: { x: 2, y: 2, zoom: 2 } })
      expect(await ctx.dataAccess.em().count(FlowUserState, { flow: flowId })).toBe(1)
    })

    it('并发存同一个分区：唯一约束靠 upsert 收敛，还是一行', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      const results = await Promise.all(
        [1, 2, 3, 4].map((x) => alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x, y: 0, zoom: 1 } })),
      )
      expect(results.map((res) => res.status)).toEqual([204, 204, 204, 204])
      expect(await ctx.dataAccess.em().count(FlowUserState, { flow: flowId })).toBe(1)
    })

    it('视图操作不动画布数据：revision 不涨，graph 里的兜底视口不变', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 3, y: 4, zoom: 1 } })

      const detail = (await alice.request(`/api/flows/${flowId}`)).json<{ revision: number; graph: FlowGraph }>()
      expect(detail.revision).toBe(0)
      expect(detail.graph.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('校验：未知分区、坏视口、空 body → 400', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      const patch = (body: unknown) => alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', body)

      expect((await patch({ 谁知道呢: 1 })).json()).toEqual({ error: '未知的状态分区：谁知道呢' })
      expect((await patch({ constructor: 1 })).status).toBe(400)
      expect((await patch({ viewport: { x: 1, y: 2 } })).status).toBe(400)
      expect((await patch({ viewport: { x: 1, y: 2, zoom: 0 } })).status).toBe(400)
      expect((await patch({ viewport: { x: 1, y: 2, zoom: Number.NaN } })).status).toBe(400)
      expect((await patch({})).json()).toEqual({ error: '至少要带一个状态分区' })
    })

    it('非成员存不了：跟读一样是 404，不泄露画布存不存在', async () => {
      const alice = await ctx.actor()
      const stranger = await ctx.actor('stranger')
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      const res = await stranger.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 1, y: 1, zoom: 1 } })
      expect(res.status).toBe(404)
      expect(await ctx.dataAccess.em().count(FlowUserState, { flow: flowId })).toBe(0)
    })

    it('画布物理删掉，附带的用户状态一起没（外键级联）', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const flowId = await createFlow(alice, projectId)

      await alice.json(`/api/flows/${flowId}/user-state`, 'PATCH', { viewport: { x: 1, y: 1, zoom: 1 } })
      await ctx.dataAccess.em().nativeDelete(Flow, { id: flowId })

      expect(await ctx.dataAccess.em().count(FlowUserState, { flow: flowId })).toBe(0)
    })
  })
})
