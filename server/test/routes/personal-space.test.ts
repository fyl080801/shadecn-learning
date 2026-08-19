import { beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_LIMITS, type ProjectSummary } from '../../store/projects.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, type Actor } from '../helpers/project.ts'

/**
 * 个人空间（REQ-SOLO）。
 *
 * 它在库里就是一个 `kind='personal'` 的项目 —— 这么建模的全部意义在于
 * 鉴权、列表、增删改一行特判都不用加。所以这里要盯的是**它作为项目的那部分行为
 * 有没有被正确地关掉**：不出现在项目列表里、没有分享链接、不能删、不限画布数。
 */

async function personalSpace(who: Actor): Promise<ProjectSummary> {
  const res = await who.request('/api/projects/personal')
  expect(res.status).toBe(200)
  return (await res.json()) as ProjectSummary
}

describe('个人空间', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('第一次访问就建出来，再访问还是同一个', async () => {
    const alice = await actor()

    const first = await personalSpace(alice)
    const second = await personalSpace(alice)

    expect(first.kind).toBe('personal')
    expect(first.myRole).toBe('admin')
    expect(second.id).toBe(first.id)
    // 唯一性由 personalOwnerId 的 unique 兜着，不靠调用方只调一次
    expect(await prisma.project.count({ where: { personalOwnerId: alice.userId } })).toBe(1)
  })

  it('并发访问只会建出一个', async () => {
    const alice = await actor()

    const results = await Promise.all([
      personalSpace(alice),
      personalSpace(alice),
      personalSpace(alice),
    ])

    expect(new Set(results.map((row) => row.id)).size).toBe(1)
    expect(await prisma.project.count({ where: { personalOwnerId: alice.userId } })).toBe(1)
  })

  it('一人一个，互相看不见', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')

    const mine = await personalSpace(alice)
    const theirs = await personalSpace(bob)
    expect(mine.id).not.toBe(theirs.id)

    // 别人的个人空间就是「不是成员」，和任何私有项目一个待遇：404
    expect((await bob.request(`/api/projects/${mine.id}`)).status).toBe(404)
    expect((await bob.request(`/api/projects/${mine.id}/flows`)).status).toBe(404)
  })

  it('不出现在项目列表里，也搜不到', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice, '真项目')

    const res = await alice.request('/api/projects?pageSize=50')
    const body = (await res.json()) as { items: ProjectSummary[]; total: number }

    expect(body.items.map((row) => row.id)).toEqual([projectId])
    expect(body.items.some((row) => row.id === space.id)).toBe(false)

    const searched = await alice.request('/api/projects?keyword=我的画布')
    expect(((await searched.json()) as { total: number }).total).toBe(0)
  })

  it('分享链接 / 成员管理 / 删除 / 改名一律 403', async () => {
    const alice = await actor()
    const other = await actor('bob')
    const space = await personalSpace(alice)

    const denied = [
      await alice.request(`/api/projects/${space.id}/invite`),
      await alice.json(`/api/projects/${space.id}/invite`, 'PATCH', { expiresInDays: 7 }),
      await alice.json(`/api/projects/${space.id}/invite/reset`, 'POST', {}),
      await alice.request(`/api/projects/${space.id}/members/${other.userId}`, {
        method: 'DELETE',
      }),
      await alice.request(`/api/projects/${space.id}`, { method: 'DELETE' }),
      await alice.json(`/api/projects/${space.id}`, 'PATCH', { name: '改个名' }),
    ]

    // 403 而不是 404：他确实是这个「项目」的成员，只是这些动作对个人空间没有意义
    expect(denied.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect(await prisma.projectInvite.count({ where: { projectId: space.id } })).toBe(0)
  })

  it('画布数不受项目上限限制', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice)

    // 造 500 张画布太慢，把上限临时压到 1 —— 检查的是「有没有走这条判断」，不是那个数
    const limits = PROJECT_LIMITS as { flows: number }
    const original = limits.flows
    limits.flows = 1
    try {
      await createFlow(alice, space.id, '第一张')
      const second = await alice.json(`/api/projects/${space.id}/flows`, 'POST', {
        name: '第二张',
      })
      expect(second.status).toBe(201)

      // 团队项目照旧受限
      await createFlow(alice, projectId, '第一张')
      const blocked = await alice.json(`/api/projects/${projectId}/flows`, 'POST', {
        name: '第二张',
      })
      expect(blocked.status).toBe(400)
    } finally {
      limits.flows = original
    }
  })

  it('里面的画布是 solo，团队项目里的是 collab', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const projectId = await createProject(alice)

    const soloId = await createFlow(alice, space.id, '个人画布')
    const collabId = await createFlow(alice, projectId, '项目画布')

    const solo = (await (await alice.request(`/api/flows/${soloId}`)).json()) as { mode: string }
    const collab = (await (await alice.request(`/api/flows/${collabId}`)).json()) as {
      mode: string
    }

    expect(solo.mode).toBe('solo')
    expect(collab.mode).toBe('collab')

    // 列表页也要能看出来 —— 前端靠它决定用哪条同步通道
    const listed = (await (
      await alice.request(`/api/projects/${space.id}/flows`)
    ).json()) as { items: { mode: string }[] }
    expect(listed.items.map((row) => row.mode)).toEqual(['solo'])
  })
})
