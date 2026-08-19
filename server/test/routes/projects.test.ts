import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app.ts'
import { createRevocationWatcher } from '../../collab/revocation.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createProject, joinViaInvite } from '../helpers/project.ts'

beforeEach(async () => {
  await resetDb()
})

describe('POST /api/projects', () => {
  it('创建者被真实写成 admin 成员，而不是靠 createdById 推断', async () => {
    const alice = await actor()
    const res = await alice.json('/api/projects', 'POST', { name: '我的项目' })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; myRole: string; memberCount: number }
    expect(body).toMatchObject({ myRole: 'admin', memberCount: 1 })

    const member = await prisma.projectMember.findFirst({
      where: { projectId: body.id, userId: alice.userId },
    })
    expect(member?.role).toBe('admin')
  })

  it('name 为空 → 400', async () => {
    const alice = await actor()
    const res = await alice.json('/api/projects', 'POST', { name: '   ' })
    expect(res.status).toBe(400)
  })

  it('未登录 → 401', async () => {
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/projects', () => {
  it('只列出我是成员的项目', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    await createProject(alice, 'A 的项目')
    await createProject(bob, 'B 的项目')

    const res = await alice.request('/api/projects')
    const body = (await res.json()) as { items: { name: string }[]; total: number }
    expect(body.total).toBe(1)
    expect(body.items[0]?.name).toBe('A 的项目')
  })

  it('分页参数生效，pageSize 越界 → 400', async () => {
    const alice = await actor()
    for (let i = 0; i < 3; i += 1) await createProject(alice, `项目 ${i}`)

    const page1 = await alice.request('/api/projects?page=1&pageSize=2')
    const body = (await page1.json()) as { items: unknown[]; total: number; totalPages: number }
    expect(body.items).toHaveLength(2)
    expect(body).toMatchObject({ total: 3, totalPages: 2 })

    expect((await alice.request('/api/projects?pageSize=101')).status).toBe(400)
    expect((await alice.request('/api/projects?page=0')).status).toBe(400)
  })

  it('软删的项目不再出现在列表里', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

    const res = await alice.request('/api/projects')
    await expect(res.json()).resolves.toMatchObject({ total: 0 })
  })
})

describe('GET /api/projects/:id', () => {
  it('非成员访问 → 404（不是 403，不泄露存在性）', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)

    expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(404)
  })

  it('成员能拿到详情与自己的角色', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)

    const res = await bob.request(`/api/projects/${projectId}`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ myRole: 'member', memberCount: 2 })
  })

  it('软删后对所有人都是 404', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

    expect((await alice.request(`/api/projects/${projectId}`)).status).toBe(404)
  })
})

describe('项目的 admin / member 权限分界', () => {
  it('member 改项目名 / 删项目 / 管分享链接 → 403', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)

    expect((await bob.json(`/api/projects/${projectId}`, 'PATCH', { name: '改名' })).status).toBe(403)
    expect((await bob.request(`/api/projects/${projectId}`, { method: 'DELETE' })).status).toBe(403)
    expect((await bob.request(`/api/projects/${projectId}/invite`)).status).toBe(403)
    expect((await bob.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})).status).toBe(403)
  })

  it('admin 能改名', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const res = await alice.json(`/api/projects/${projectId}`, 'PATCH', { name: '新名字' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ name: '新名字' })
  })
})

describe('成员管理', () => {
  it('所有成员都能看成员列表', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)

    const res = await bob.request(`/api/projects/${projectId}/members`)
    expect(res.status).toBe(200)
    const members = (await res.json()) as { userId: string; role: string }[]
    expect(members).toHaveLength(2)
    expect(members.find((m) => m.userId === alice.userId)?.role).toBe('admin')
    expect(members.find((m) => m.userId === bob.userId)?.role).toBe('member')
  })

  it('admin 移除成员后，被移除者立刻拿不到项目', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)

    const res = await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)
    expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(404)
  })

  /**
   * 移除成员必须把**正在协同编辑**的那条 WebSocket 也断掉，而且不能等定期复验：
   * 那段时间里他改的东西会被 CRDT 合并、落库，其他人还撤销不回来
   * （撤销只跟踪自己的 origin）。本实例当场踢，别的实例靠这条广播跟上。
   */
  it('移除成员会广播权限撤销 —— 人挂在别的实例上也踢得到', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)

    // 另一个实例：先对齐，此后只有真的有人被撤权才会为真
    const otherInstance = createRevocationWatcher()
    await otherInstance.changed()

    await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })

    expect(await otherInstance.changed()).toBe(true)
  })

  it('删项目同样广播 —— 项目没了，它下面画布房间里的人都该断开', async () => {
    const alice = await actor('alice')
    const projectId = await createProject(alice)

    const otherInstance = createRevocationWatcher()
    await otherInstance.changed()

    await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

    expect(await otherInstance.changed()).toBe(true)
  })

  it('admin 移除自己 → 400', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const res = await alice.request(`/api/projects/${projectId}/members/${alice.userId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(400)
  })
})
