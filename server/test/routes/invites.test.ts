import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createProject, type Actor } from '../helpers/project.ts'

beforeEach(async () => {
  await resetDb()
})

interface InviteBody {
  id: string
  token: string
  url: string
  expiresAt: string
  maxUses: number | null
  usedCount: number
}

async function newInvite(admin: Actor, projectId: string, body: unknown = {}) {
  const res = await admin.json(`/api/projects/${projectId}/invites`, 'POST', body)
  return { res, invite: (await res.json()) as InviteBody }
}

describe('POST /api/projects/:id/invites', () => {
  it('生成的邀请带完整可复制的链接', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const { res, invite } = await newInvite(alice, projectId)
    expect(res.status).toBe(201)
    expect(invite.url).toBe(`http://127.0.0.1:3000/invite/${invite.token}`)
    expect(invite.maxUses).toBeNull()
  })

  it('expiresInDays 只接受 1 / 7 / 30', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    expect((await newInvite(alice, projectId, { expiresInDays: 3 })).res.status).toBe(400)
    expect((await newInvite(alice, projectId, { expiresInDays: 30 })).res.status).toBe(201)
  })

  it('maxUses 越界 → 400', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    expect((await newInvite(alice, projectId, { maxUses: 0 })).res.status).toBe(400)
    expect((await newInvite(alice, projectId, { maxUses: 1001 })).res.status).toBe(400)
    expect((await newInvite(alice, projectId, { maxUses: 1 })).res.status).toBe(201)
  })
})

describe('GET /api/invites/:token', () => {
  it('预览给出项目名与成员数，不需要先是成员', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice, '设计部')
    const { invite } = await newInvite(alice, projectId)

    const res = await bob.request(`/api/invites/${invite.token}`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      valid: true,
      projectName: '设计部',
      memberCount: 1,
      alreadyMember: false,
    })
  })

  it('已经是成员时告知，前端可以直接换成「进入项目」', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)

    const res = await alice.request(`/api/invites/${invite.token}`)
    await expect(res.json()).resolves.toMatchObject({ valid: true, alreadyMember: true })
  })

  it('三种失效状态给各自的文案', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)

    // 已撤销
    const revoked = (await newInvite(alice, projectId)).invite
    await alice.request(`/api/projects/${projectId}/invites/${revoked.id}`, { method: 'DELETE' })

    // 已过期
    const expired = (await newInvite(alice, projectId)).invite
    await prisma.projectInvite.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    // 次数用尽
    const exhausted = (await newInvite(alice, projectId, { maxUses: 1 })).invite
    await prisma.projectInvite.update({ where: { id: exhausted.id }, data: { usedCount: 1 } })

    const read = async (token: string) =>
      (await (await bob.request(`/api/invites/${token}`)).json()) as {
        valid: boolean
        reason: string
        message: string
      }

    expect(await read(revoked.token)).toMatchObject({ valid: false, reason: 'revoked' })
    expect(await read(expired.token)).toMatchObject({ valid: false, reason: 'expired' })
    expect(await read(exhausted.token)).toMatchObject({ valid: false, reason: 'exhausted' })
    expect(await read('不存在的-token')).toMatchObject({ valid: false, reason: 'not_found' })

    // 四种原因的文案互不相同
    const messages = await Promise.all(
      [revoked.token, expired.token, exhausted.token, '不存在的-token'].map(async (t) =>
        (await read(t)).message,
      ),
    )
    expect(new Set(messages).size).toBe(4)
  })

  it('项目被软删 → project_deleted', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)
    await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

    const res = await bob.request(`/api/invites/${invite.token}`)
    await expect(res.json()).resolves.toMatchObject({ valid: false, reason: 'project_deleted' })
  })

  it('未登录 → 401', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)

    expect((await app.request(`/api/invites/${invite.token}`)).status).toBe(401)
  })
})

describe('POST /api/invites/:token/accept', () => {
  it('接受后成为成员，usedCount +1', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)

    const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ projectId })

    expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(200)

    const row = await prisma.projectInvite.findUnique({ where: { id: invite.id } })
    expect(row?.usedCount).toBe(1)
  })

  it('加入者记录了邀请人', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)
    await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

    const member = await prisma.projectMember.findFirst({
      where: { projectId, userId: bob.userId },
    })
    expect(member?.invitedById).toBe(alice.userId)
  })

  it('重复接受是幂等的：不产生第二条成员记录，也不涨 usedCount', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId, { maxUses: 1 })

    await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    const second = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

    expect(second.status).toBe(200)
    expect(await prisma.projectMember.count({ where: { projectId, userId: bob.userId } })).toBe(1)
    const row = await prisma.projectInvite.findUnique({ where: { id: invite.id } })
    expect(row?.usedCount).toBe(1)
  })

  it('次数用尽后别人再也进不来', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const carol = await actor('carol')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId, { maxUses: 1 })

    await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    const res = await carol.json(`/api/invites/${invite.token}/accept`, 'POST')

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ reason: 'exhausted' })
  })

  it('不存在的 token → 404', async () => {
    const bob = await actor()
    const res = await bob.json('/api/invites/无效/accept', 'POST')
    expect(res.status).toBe(404)
  })

  it('撤销后的链接不能再用', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await newInvite(alice, projectId)
    await alice.request(`/api/projects/${projectId}/invites/${invite.id}`, { method: 'DELETE' })

    const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ reason: 'revoked' })
  })
})

describe('GET /api/projects/:id/invites', () => {
  it('只列出有效的邀请', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const keep = (await newInvite(alice, projectId)).invite
    const revoked = (await newInvite(alice, projectId)).invite
    await alice.request(`/api/projects/${projectId}/invites/${revoked.id}`, { method: 'DELETE' })

    const used = (await newInvite(alice, projectId, { maxUses: 1 })).invite
    await prisma.projectInvite.update({ where: { id: used.id }, data: { usedCount: 1 } })

    const res = await alice.request(`/api/projects/${projectId}/invites`)
    const list = (await res.json()) as InviteBody[]
    expect(list.map((item) => item.id)).toEqual([keep.id])
  })

  it('撤销一条不存在的邀请 → 404', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const res = await alice.request(`/api/projects/${projectId}/invites/nope`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
