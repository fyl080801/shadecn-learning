import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessRevocation, type RevocationWatcher } from '../src/access-revocation.js'
import { ProjectMember } from '../src/entities.js'
import { PROJECT_LIMITS } from '../src/projects.service.js'
import { createFlow, createProject, describeOnBothDatabases, joinViaInvite } from './helpers.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describeOnBothDatabases('项目接口', (ctx) => {
  describe('POST /api/projects', () => {
    it('创建者被真实写成 admin 成员，而不是靠 createdById 推断', async () => {
      const alice = await ctx.actor()
      const res = await alice.json('/api/projects', 'POST', { name: '我的项目' })

      expect(res.status).toBe(201)
      const body = res.json<{ id: string }>()
      expect(body).toMatchObject({ myRole: 'admin', memberCount: 1 })

      const member = await ctx.dataAccess.em().findOne(ProjectMember, { project: body.id, user: alice.userId })
      expect(member?.role).toBe('admin')
    })

    it('响应形状和现有接口一致：字段齐全，时间是带 Z 的 ISO', async () => {
      const alice = await ctx.actor()
      const body = (await alice.json('/api/projects', 'POST', { name: '  有空格  ', description: '描述' })).json()

      expect(Object.keys(body).sort()).toEqual(
        ['createdAt', 'createdById', 'description', 'flowCount', 'id', 'kind', 'memberCount', 'myRole', 'name', 'updatedAt'].sort(),
      )
      expect(body).toMatchObject({ name: '有空格', description: '描述', kind: 'team', flowCount: 0, createdById: alice.userId })
      expect(body.createdAt).toMatch(ISO)
      expect(body.updatedAt).toMatch(ISO)
    })

    it('name 为空 → 400，错误放在 error 字段（前端弹给用户）', async () => {
      const alice = await ctx.actor()
      const res = await alice.json('/api/projects', 'POST', { name: '   ' })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: 'name 不能为空' })
    })

    it('name 超长、description 类型不对 → 400', async () => {
      const alice = await ctx.actor()
      expect((await alice.json('/api/projects', 'POST', { name: 'x'.repeat(81) })).json()).toEqual({ error: 'name 不能超过 80 个字符' })
      expect((await alice.json('/api/projects', 'POST', { name: 'x', description: 1 })).json()).toEqual({ error: 'description 必须是字符串或 null' })
    })

    it.each([
      ['语法错误的 JSON', '{不是 json'],
      ['原型污染', '{"__proto__":{"a":1},"name":"x"}'],
      ['null', 'null'],
    ])('请求体是%s → 400 + 统一的那句话', async (_label, body) => {
      const alice = await ctx.actor()
      const res = await alice.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: '请求体不是合法 JSON' })
    })

    it('没有请求体 → 400 + 统一的那句话', async () => {
      const alice = await ctx.actor()
      const res = await alice.request('/api/projects', { method: 'POST' })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: '请求体不是合法 JSON' })
    })

    it('和 Hono 版不同的边角：Fastify 按 content-type 解析，且在判权之前', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)

      // 前端没有请求体时不带 content-type，走不到这里
      const empty = await alice.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' } })
      expect(empty.status).toBe(400)
      expect(empty.json()).toEqual({ error: '请求体不是合法 JSON' })
      // 非成员的坏请求体先是 400，不泄露存在性：不存在的项目也是这样
      const bad = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{' }
      expect((await bob.request(`/api/projects/${projectId}`, bad)).status).toBe(400)
      expect((await bob.request('/api/projects/none', bad)).status).toBe(400)
      // text/plain 的请求体是字符串，取不到字段
      const text = await alice.request('/api/projects', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'x' }) })
      expect(text.json()).toEqual({ error: 'name 必须是字符串' })
    })

    it('别的模块的接口不受这个过滤器影响：坏请求体是 Nest 的默认形状', async () => {
      const alice = await ctx.actor()
      const res = await alice.request('/api/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
      expect(res.json()).not.toEqual({ error: '请求体不是合法 JSON' })
    })

    it('未登录 → 401，形状和现有接口一致', async () => {
      const res = await ctx.anonymous('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      })
      expect(res.status).toBe(401)
      expect(res.json()).toMatchObject({ error: 'Unauthorized', message: '需要登录' })
    })

    it('编码路径绕不过登录：/%61pi/projects → 401', async () => {
      expect((await ctx.anonymous('/%61pi/projects')).status).toBe(401)
    })
  })

  describe('GET /api/projects', () => {
    it('只列出我是成员的项目', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      await createProject(alice, 'A 的项目')
      await createProject(bob, 'B 的项目')

      const body = (await alice.request('/api/projects')).json<{ items: { name: string }[]; total: number }>()
      expect(body.total).toBe(1)
      expect(body.items[0]?.name).toBe('A 的项目')
    })

    it('分页参数生效，pageSize 越界 → 400', async () => {
      const alice = await ctx.actor()
      for (let i = 0; i < 3; i += 1) await createProject(alice, `项目 ${i}`)

      const body = (await alice.request('/api/projects?page=1&pageSize=2')).json<{ items: unknown[] }>()
      expect(body.items).toHaveLength(2)
      expect(body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 })

      expect((await alice.request('/api/projects?pageSize=101')).status).toBe(400)
      expect((await alice.request('/api/projects?page=0')).status).toBe(400)
      expect((await alice.request('/api/projects?page=x')).json()).toEqual({ error: 'page 必须是正整数' })
    })

    it('关键字大小写不敏感，% 和 _ 按字面匹配', async () => {
      const alice = await ctx.actor()
      await createProject(alice, 'Alpha')
      await createProject(alice, '100%完成')

      const count = async (keyword: string) =>
        (await alice.request(`/api/projects?keyword=${encodeURIComponent(keyword)}`)).json<{ total: number }>().total
      expect(await count('ALPH')).toBe(1)
      expect(await count('100%')).toBe(1)
      expect(await count('%')).toBe(1)
      expect(await count('_')).toBe(0)
      expect(await count('  ')).toBe(2)
    })

    it('计数按项目分开，软删的画布不算', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const one = await createProject(alice, '一')
      const two = await createProject(alice, '二')
      await joinViaInvite(alice, one, bob)
      await createFlow(alice, one)
      const gone = await createFlow(alice, one)
      await alice.request(`/api/flows/${gone}`, { method: 'DELETE' })

      const items = (await alice.request('/api/projects')).json<{ items: { id: string; memberCount: number; flowCount: number }[] }>().items
      expect(items.find((row) => row.id === one)).toMatchObject({ memberCount: 2, flowCount: 1 })
      expect(items.find((row) => row.id === two)).toMatchObject({ memberCount: 1, flowCount: 0 })
    })

    it('软删的项目不再出现在列表里', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })
      expect((await alice.request('/api/projects')).json()).toMatchObject({ total: 0 })
    })
  })

  describe('GET /api/projects/:id', () => {
    it('非成员访问 → 404（不是 403，不泄露存在性），文案和不存在的项目相同', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)

      const res = await bob.request(`/api/projects/${projectId}`)
      expect(res.status).toBe(404)
      expect(res.json()).toEqual({ error: 'Not Found', message: '项目不存在' })
      expect((await bob.request('/api/projects/none')).json()).toEqual(res.json())
    })

    it('成员能拿到详情与自己的角色', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)

      const res = await bob.request(`/api/projects/${projectId}`)
      expect(res.status).toBe(200)
      expect(res.json()).toMatchObject({ myRole: 'member', memberCount: 2 })
    })

    it('软删后对所有人都是 404', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })
      expect((await alice.request(`/api/projects/${projectId}`)).status).toBe(404)
    })
  })

  describe('项目的 admin / member 权限分界', () => {
    it('member 改项目名 / 删项目 / 管分享链接 → 403，文案指明要管理员', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)

      const denied = await bob.json(`/api/projects/${projectId}`, 'PATCH', { name: '改名' })
      expect(denied.status).toBe(403)
      expect(denied.json()).toEqual({ error: 'Forbidden', message: '需要项目管理员权限' })
      expect((await bob.request(`/api/projects/${projectId}`, { method: 'DELETE' })).status).toBe(403)
      expect((await bob.request(`/api/projects/${projectId}/invite`)).status).toBe(403)
      expect((await bob.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})).status).toBe(403)
    })

    it('非成员碰 admin 接口是 404，不是 403', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      expect((await bob.json(`/api/projects/${projectId}`, 'PATCH', { name: '改名' })).status).toBe(404)
      expect((await bob.request(`/api/projects/${projectId}/invite`)).status).toBe(404)
    })

    it('admin 能改名；只带要改的字段', async () => {
      const alice = await ctx.actor()
      const projectId = (await alice.json('/api/projects', 'POST', { name: '旧名字', description: '留着' })).json<{ id: string }>().id

      const res = await alice.json(`/api/projects/${projectId}`, 'PATCH', { name: '新名字' })
      expect(res.status).toBe(200)
      expect(res.json()).toMatchObject({ name: '新名字', description: '留着' })

      const cleared = await alice.json(`/api/projects/${projectId}`, 'PATCH', { description: null })
      expect(cleared.json()).toMatchObject({ name: '新名字', description: null })
    })
  })

  describe('成员管理', () => {
    it('所有成员都能看成员列表', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)

      const res = await bob.request(`/api/projects/${projectId}/members`)
      expect(res.status).toBe(200)
      const members = res.json<{ userId: string; role: string; joinedAt: string; invitedById: string | null }[]>()
      expect(members).toHaveLength(2)
      expect(members[0]).toMatchObject({ userId: alice.userId, role: 'admin', invitedById: null })
      expect(members[1]).toMatchObject({ userId: bob.userId, role: 'member', invitedById: alice.userId })
      expect(Object.keys(members[0] as object).sort()).toEqual(['avatarUrl', 'email', 'invitedById', 'joinedAt', 'name', 'role', 'userId', 'username'])
      expect(members[0]?.joinedAt).toMatch(ISO)
    })

    it('admin 移除成员后，被移除者立刻拿不到项目', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)

      const res = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(res.text).toBe('')
      expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(404)
    })

    it('移除不是成员的人 → 404', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const res = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })
      expect(res.status).toBe(404)
      expect(res.json()).toEqual({ error: 'Not Found', message: '成员不存在' })
    })

    it('最后一个 admin 留得住：admin 移除自己 → 400，member 也动不了他', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      await joinViaInvite(alice, projectId, bob)

      const self = await alice.request(`/api/projects/${projectId}/members/${alice.userId}`, { method: 'DELETE' })
      expect(self.status).toBe(400)
      expect(self.json()).toEqual({ error: '不能移除自己；如需退出请让其他管理员操作' })
      expect((await bob.request(`/api/projects/${projectId}/members/${alice.userId}`, { method: 'DELETE' })).status).toBe(403)
      expect((await alice.request(`/api/projects/${projectId}`)).json()).toMatchObject({ myRole: 'admin', memberCount: 2 })
    })

    describe('撤权信号', () => {
      let watcher: RevocationWatcher
      let notified: ReturnType<typeof vi.fn<() => void>>
      let stop: () => void

      beforeEach(async () => {
        const revocation = ctx.app.get(AccessRevocation)
        notified = vi.fn<() => void>()
        stop = revocation.onRevoked(notified)
        // 另一个实例：先对齐，此后只有真的有人被撤权才会为真
        watcher = revocation.createWatcher()
        await watcher.changed()
      })

      afterEach(() => stop())

      it('移除成员：别的实例看得到世代号变化，本实例的订阅者在 204 之前已经处理完', async () => {
        const alice = await ctx.actor('alice')
        const bob = await ctx.actor('bob')
        const projectId = await createProject(alice)
        await joinViaInvite(alice, projectId, bob)
        expect(await watcher.changed()).toBe(false)

        await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })

        expect(notified).toHaveBeenCalledTimes(1)
        expect(await watcher.changed()).toBe(true)
        expect(await watcher.changed()).toBe(false)
      })

      it('删项目和删画布同样广播', async () => {
        const alice = await ctx.actor('alice')
        const projectId = await createProject(alice)
        const flowId = await createFlow(alice, projectId)

        await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })
        expect(await watcher.changed()).toBe(true)

        await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })
        expect(await watcher.changed()).toBe(true)
        expect(notified).toHaveBeenCalledTimes(2)
      })

      it('失败的移除不广播', async () => {
        const alice = await ctx.actor('alice')
        const projectId = await createProject(alice)
        await alice.request(`/api/projects/${projectId}/members/${alice.userId}`, { method: 'DELETE' })
        expect(notified).not.toHaveBeenCalled()
        expect(await watcher.changed()).toBe(false)
      })

      it('订阅者抛错不影响接口', async () => {
        const silenced = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const revocation = ctx.app.get(AccessRevocation)
        const off = revocation.onRevoked(() => {
          throw new Error('订阅者坏了')
        })
        const alice = await ctx.actor('alice')
        const projectId = await createProject(alice)
        expect((await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })).status).toBe(204)
        off()
        silenced.mockRestore()
      })
    })
  })

  it('PROJECT_LIMITS 就是现有的值', () => {
    expect(PROJECT_LIMITS).toEqual({ members: 200, flows: 500 })
  })
})
