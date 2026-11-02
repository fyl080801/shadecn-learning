import type { ProjectSummary } from '@learning/contracts/canvas'
import { expect, it } from 'vitest'
import { Project, ProjectInvite } from '../src/entities.js'
import { PROJECT_LIMITS } from '../src/projects.service.js'
import { type Actor, createFlow, createProject, describeOnBothDatabases } from './helpers.js'

/**
 * 个人空间（docs/16）。它在库里就是一个 `kind='personal'` 的项目 —— 这么建模的全部意义在于判权、列表、增删改一行特判都不用加。
 * 所以这里要盯的是**它作为项目的那部分行为有没有被正确地关掉**：不出现在项目列表里、没有分享链接、不能删、不限画布数。
 */
describeOnBothDatabases('个人空间', (ctx) => {
  async function personalSpace(who: Actor): Promise<ProjectSummary> {
    const res = await who.request('/api/projects/personal')
    expect(res.status).toBe(200)
    return res.json<ProjectSummary>()
  }

  it('第一次访问就建出来，再访问还是同一个', async () => {
    const alice = await ctx.actor()

    const first = await personalSpace(alice)
    const second = await personalSpace(alice)

    expect(first.kind).toBe('personal')
    expect(first.myRole).toBe('admin')
    expect(first.memberCount).toBe(1)
    expect(second.id).toBe(first.id)
    // 唯一性由 personalOwner 的 unique 兜着，不靠调用方只调一次
    expect(await ctx.dataAccess.em().count(Project, { personalOwner: alice.userId })).toBe(1)
  })

  it('登录路径上不建：没访问过个人画布就没有这一行（docs/16 §3.1）', async () => {
    const alice = await ctx.actor()
    expect(await ctx.dataAccess.em().count(Project, { personalOwner: alice.userId })).toBe(0)
    expect((await alice.request('/api/projects')).json()).toMatchObject({ total: 0 })
    expect(await ctx.dataAccess.em().count(Project, { personalOwner: alice.userId })).toBe(0)
  })

  it('并发访问只会建出一个：输掉唯一约束的那个重查', async () => {
    const alice = await ctx.actor()

    const results = await Promise.all([personalSpace(alice), personalSpace(alice), personalSpace(alice)])

    expect(new Set(results.map((row) => row.id)).size).toBe(1)
    expect(await ctx.dataAccess.em().count(Project, { personalOwner: alice.userId })).toBe(1)
  })

  it('一人一个，互相看不见', async () => {
    const alice = await ctx.actor('alice')
    const bob = await ctx.actor('bob')

    const mine = await personalSpace(alice)
    const theirs = await personalSpace(bob)
    expect(mine.id).not.toBe(theirs.id)

    // 别人的个人空间就是「不是成员」，和任何私有项目一个待遇：404
    expect((await bob.request(`/api/projects/${mine.id}`)).status).toBe(404)
    expect((await bob.request(`/api/projects/${mine.id}/flows`)).status).toBe(404)
  })

  it('不出现在项目列表里，也搜不到', async () => {
    const alice = await ctx.actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice, '真项目')

    const body = (await alice.request('/api/projects?pageSize=50')).json<{ items: ProjectSummary[] }>()
    expect(body.items.map((row) => row.id)).toEqual([projectId])
    expect(body.items.some((row) => row.id === space.id)).toBe(false)

    const searched = await alice.request(`/api/projects?keyword=${encodeURIComponent('我的画布')}`)
    expect(searched.json<{ total: number }>().total).toBe(0)
  })

  it('分享链接 / 成员管理 / 删除 / 改名一律 403', async () => {
    const alice = await ctx.actor()
    const other = await ctx.actor('bob')
    const space = await personalSpace(alice)

    const denied = [
      await alice.request(`/api/projects/${space.id}/invite`),
      await alice.json(`/api/projects/${space.id}/invite`, 'PATCH', { expiresInDays: 7 }),
      await alice.json(`/api/projects/${space.id}/invite/reset`, 'POST', {}),
      await alice.request(`/api/projects/${space.id}/members/${other.userId}`, { method: 'DELETE' }),
      await alice.request(`/api/projects/${space.id}`, { method: 'DELETE' }),
      await alice.json(`/api/projects/${space.id}`, 'PATCH', { name: '改个名' }),
    ]

    // 403 而不是 404：他确实是这个「项目」的成员，只是这些动作对个人空间没有意义
    expect(denied.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect(denied[0]?.json()).toEqual({ error: 'Forbidden', message: '个人空间不支持这个操作' })
    expect(await ctx.dataAccess.em().count(ProjectInvite, { project: space.id })).toBe(0)
  })

  it('画布数不受项目上限限制，团队项目照旧受限', async () => {
    const alice = await ctx.actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice)

    // 造 500 张画布太慢，把上限临时压到 1 —— 检查的是「有没有走这条判断」，不是那个数
    const limits = PROJECT_LIMITS as { flows: number }
    const original = limits.flows
    limits.flows = 1
    try {
      await createFlow(alice, space.id, '第一张')
      expect((await alice.json(`/api/projects/${space.id}/flows`, 'POST', { name: '第二张' })).status).toBe(201)

      await createFlow(alice, projectId, '第一张')
      const blocked = await alice.json(`/api/projects/${projectId}/flows`, 'POST', { name: '第二张' })
      expect(blocked.status).toBe(400)
      expect(blocked.json()).toEqual({ error: '项目内画布数已达上限 1' })
    } finally {
      limits.flows = original
    }
  })

  it('里面的画布是 solo，团队项目里的是 collab', async () => {
    const alice = await ctx.actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice)

    const soloId = await createFlow(alice, space.id, '个人画布')
    const collabId = await createFlow(alice, projectId, '项目画布')

    expect((await alice.request(`/api/flows/${soloId}`)).json().mode).toBe('solo')
    expect((await alice.request(`/api/flows/${collabId}`)).json().mode).toBe('collab')

    // 列表页也要能看出来 —— 前端靠它决定用哪条同步通道
    const listed = (await alice.request(`/api/projects/${space.id}/flows`)).json<{ items: { mode: string }[] }>()
    expect(listed.items.map((row) => row.mode)).toEqual(['solo'])
  })
})
