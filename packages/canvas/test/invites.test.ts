import { describe, expect, it, vi } from 'vitest'
import { ProjectInvite, ProjectMember } from '../src/entities.js'
import { PROJECT_LIMITS } from '../src/projects.service.js'
import { type Actor, createProject, describeOnBothDatabases, ORIGIN } from './helpers.js'

interface InviteBody {
  id: string
  projectId: string
  token: string
  url: string
  role: string
  createdById: string
  createdAt: string
  expiresAt: string
}

describeOnBothDatabases('分享链接', (ctx) => {
  /** 打开分享面板：GET 是幂等的，没有链接时服务端当场建一条 */
  async function share(admin: Actor, projectId: string) {
    const res = await admin.request(`/api/projects/${projectId}/invite`)
    return { res, invite: res.json<InviteBody>() }
  }

  /** 让一条链接过期 */
  const expire = (token: string) => ctx.dataAccess.em().nativeUpdate(ProjectInvite, { token }, { expiresAt: new Date(Date.now() - 1000) })

  const inviteRows = (projectId: string) => ctx.dataAccess.em().count(ProjectInvite, { project: projectId })

  describe('GET /api/projects/:id/invite', () => {
    it('打开即拿到完整可复制的链接，不需要先「生成」', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const { res, invite } = await share(alice, projectId)
      expect(res.status).toBe(200)
      expect(invite.url).toBe(`${ORIGIN}/invite/${invite.token}`)
      expect(invite).toMatchObject({ projectId, role: 'member', createdById: alice.userId })
      expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now())
      expect(invite.expiresAt).toMatch(/Z$/)
    })

    it('域名跟着请求走，白名单之外回落默认', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const evil = await alice.request(`/api/projects/${projectId}/invite`, { headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' } })
      expect(evil.json<InviteBody>().url.startsWith(`${ORIGIN}/invite/`)).toBe(true)
    })

    it('重复打开拿到的是同一条链接', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const first = (await share(alice, projectId)).invite
      const second = (await share(alice, projectId)).invite

      expect(second.token).toBe(first.token)
      expect(await inviteRows(projectId)).toBe(1)
    })

    it('已过期时自动换一条新的', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const old = (await share(alice, projectId)).invite
      await expire(old.token)

      const fresh = (await share(alice, projectId)).invite
      expect(fresh.token).not.toBe(old.token)
      expect(new Date(fresh.expiresAt).getTime()).toBeGreaterThan(Date.now())
      expect(await inviteRows(projectId)).toBe(1)
    })

    it('并发打开也只有一行：唯一约束撞上时走 upsert，不报错', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const results = await Promise.all([share(alice, projectId), share(alice, projectId), share(alice, projectId)])

      expect(results.map(({ res }) => res.status)).toEqual([200, 200, 200])
      expect(await inviteRows(projectId)).toBe(1)
    })
  })

  describe('PATCH /api/projects/:id/invite', () => {
    it('改有效期不换 token —— 已经发出去的链接继续可用', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const before = (await share(alice, projectId)).invite

      const res = await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 30 })
      expect(res.status).toBe(200)
      const after = res.json<InviteBody>()

      expect(after.token).toBe(before.token)
      expect(new Date(after.expiresAt).getTime()).toBeGreaterThan(new Date(before.expiresAt).getTime())
      expect(after.url).toBe(before.url)
    })

    it('expiresInDays 只接受 1 / 7 / 30', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      const bad = await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 3 })
      expect(bad.status).toBe(400)
      expect(bad.json()).toEqual({ error: 'expiresInDays 只能是 1 / 7 / 30' })

      expect((await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 1 })).status).toBe(200)
    })

    it('已过期时改有效期等于重新生成', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const old = (await share(alice, projectId)).invite
      await expire(old.token)

      const after = (await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 7 })).json<InviteBody>()
      expect(after.token).not.toBe(old.token)
    })
  })

  describe('POST /api/projects/:id/invite/reset', () => {
    it('重置换掉 token，旧链接立刻失效；状态码是 200 不是 201', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const old = (await share(alice, projectId)).invite

      const res = await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})
      expect(res.status).toBe(200)
      const fresh = res.json<InviteBody>()
      expect(fresh.token).not.toBe(old.token)

      expect((await bob.json(`/api/invites/${old.token}/accept`, 'POST')).status).toBe(404)
      // 新链接照样能用
      expect((await bob.json(`/api/invites/${fresh.token}/accept`, 'POST')).status).toBe(200)
    })

    it('不带请求体也行：有效期取默认的 7 天', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const res = await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST')
      expect(res.status).toBe(200)
      const days = (new Date(res.json<InviteBody>().expiresAt).getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThanOrEqual(7)
    })

    it('项目始终只有一条分享链接', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)

      await share(alice, projectId)
      await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})
      await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', { expiresInDays: 1 })

      expect(await inviteRows(projectId)).toBe(1)
    })
  })

  describe('GET /api/invites/:token', () => {
    it('预览给出项目名与成员数，不需要先是成员', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice, '设计部')
      const { invite } = await share(alice, projectId)

      const res = await bob.request(`/api/invites/${invite.token}`)
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ valid: true, projectId, projectName: '设计部', memberCount: 1, alreadyMember: false })
    })

    it('已经是成员时告知，前端可以直接换成「进入项目」；链接过期也不影响他', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)

      expect((await alice.request(`/api/invites/${invite.token}`)).json()).toMatchObject({ valid: true, alreadyMember: true })
      await expire(invite.token)
      expect((await alice.request(`/api/invites/${invite.token}`)).json()).toMatchObject({ valid: true, alreadyMember: true })
    })

    it('过期 / 重置 / 项目已删各给各的文案', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')

      const expiredProject = await createProject(alice, '过期项目')
      const expired = (await share(alice, expiredProject)).invite
      await expire(expired.token)

      const resetProject = await createProject(alice, '重置项目')
      const beforeReset = (await share(alice, resetProject)).invite
      await alice.json(`/api/projects/${resetProject}/invite/reset`, 'POST', {})

      const read = async (token: string) => (await bob.request(`/api/invites/${encodeURIComponent(token)}`)).json()

      expect(await read(expired.token)).toMatchObject({ valid: false, reason: 'expired', message: '分享链接已过期' })
      // 重置后旧 token 已经不存在了
      expect(await read(beforeReset.token)).toEqual({ valid: false, reason: 'not_found', alreadyMember: false, message: '分享链接无效或已被重置' })
      expect(await read('不存在的-token')).toMatchObject({ valid: false, reason: 'not_found' })
    })

    it('项目被软删 → project_deleted', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)
      await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

      expect((await bob.request(`/api/invites/${invite.token}`)).json()).toMatchObject({ valid: false, reason: 'project_deleted', message: '项目已被删除' })
    })

    it('成员数已满 → project_full；已经是成员的不受影响', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)

      const limits = PROJECT_LIMITS as { members: number }
      const original = limits.members
      limits.members = 1
      try {
        expect((await bob.request(`/api/invites/${invite.token}`)).json()).toMatchObject({ valid: false, reason: 'project_full', message: '项目成员数已达上限' })
        const accepted = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
        expect(accepted.status).toBe(400)
        expect(accepted.json()).toEqual({ error: '项目成员数已达上限', reason: 'project_full' })
        expect((await alice.request(`/api/invites/${invite.token}`)).json()).toMatchObject({ valid: true })
      } finally {
        limits.members = original
      }
    })

    it('未登录 → 401', async () => {
      const alice = await ctx.actor()
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)
      expect((await ctx.anonymous(`/api/invites/${invite.token}`)).status).toBe(401)
    })
  })

  describe('POST /api/invites/:token/accept', () => {
    it('接受后成为成员，状态码 200', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)

      const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ projectId })
      expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(200)
    })

    it('同一条链接可以被任意多人使用', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const carol = await ctx.actor('carol')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)

      expect((await bob.json(`/api/invites/${invite.token}/accept`, 'POST')).status).toBe(200)
      expect((await carol.json(`/api/invites/${invite.token}/accept`, 'POST')).status).toBe(200)
      expect(await ctx.dataAccess.em().count(ProjectMember, { project: projectId })).toBe(3)
    })

    it('加入者记录了分享人', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)
      await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

      const member = await ctx.dataAccess.em().findOne(ProjectMember, { project: projectId, user: bob.userId })
      expect(member?.invitedById).toBe(alice.userId)
    })

    it('重复接受是幂等的：不产生第二条成员记录', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)

      await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
      const second = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

      expect(second.status).toBe(200)
      expect(await ctx.dataAccess.em().count(ProjectMember, { project: projectId, user: bob.userId })).toBe(1)
    })

    it('同一个人并发接受：唯一约束挡住第二条，都算成功', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)
      // 两边都先判定「还不是成员」，才真的撞上唯一约束，不靠时序碰运气
      const { ProjectsService } = await import('../src/projects.service.js')
      const service = ctx.app.get(ProjectsService)
      const preview = service.previewInvite.bind(service)
      const notYet = await preview(invite.token, bob.userId)
      const spy = vi.spyOn(service, 'previewInvite').mockResolvedValue(notYet)

      const results = await Promise.all([
        bob.json(`/api/invites/${invite.token}/accept`, 'POST'),
        bob.json(`/api/invites/${invite.token}/accept`, 'POST'),
        bob.json(`/api/invites/${invite.token}/accept`, 'POST'),
      ])
      spy.mockRestore()

      expect(results.map((res) => res.status)).toEqual([200, 200, 200])
      expect(await ctx.dataAccess.em().count(ProjectMember, { project: projectId, user: bob.userId })).toBe(1)
    })

    it('过期的链接不能再用', async () => {
      const alice = await ctx.actor('alice')
      const bob = await ctx.actor('bob')
      const projectId = await createProject(alice)
      const { invite } = await share(alice, projectId)
      await expire(invite.token)

      const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: '分享链接已过期', reason: 'expired' })
    })

    it('不存在的 token → 404', async () => {
      const bob = await ctx.actor()
      const res = await bob.json(`/api/invites/${encodeURIComponent('无效')}/accept`, 'POST')
      expect(res.status).toBe(404)
      expect(res.json()).toEqual({ error: '分享链接无效或已被重置', reason: 'not_found' })
    })
  })
})
