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
}

/** 打开分享面板：GET 是幂等的，没有链接时服务端当场建一条 */
async function share(admin: Actor, projectId: string) {
  const res = await admin.request(`/api/projects/${projectId}/invite`)
  return { res, invite: (await res.json()) as InviteBody }
}

/** 让一条链接过期 */
async function expire(token: string) {
  await prisma.projectInvite.update({
    where: { token },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
}

describe('GET /api/projects/:id/invite', () => {
  it('打开即拿到完整可复制的链接，不需要先「生成」', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const { res, invite } = await share(alice, projectId)
    expect(res.status).toBe(200)
    expect(invite.url).toBe(`http://127.0.0.1:3000/invite/${invite.token}`)
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('重复打开拿到的是同一条链接', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const first = (await share(alice, projectId)).invite
    const second = (await share(alice, projectId)).invite

    expect(second.token).toBe(first.token)
    expect(await prisma.projectInvite.count({ where: { projectId } })).toBe(1)
  })

  it('已过期时自动换一条新的', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const old = (await share(alice, projectId)).invite
    await expire(old.token)

    const fresh = (await share(alice, projectId)).invite
    expect(fresh.token).not.toBe(old.token)
    expect(new Date(fresh.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(await prisma.projectInvite.count({ where: { projectId } })).toBe(1)
  })
})

describe('PATCH /api/projects/:id/invite', () => {
  it('改有效期不换 token —— 已经发出去的链接继续可用', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const before = (await share(alice, projectId)).invite

    const res = await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', {
      expiresInDays: 30,
    })
    expect(res.status).toBe(200)
    const after = (await res.json()) as InviteBody

    expect(after.token).toBe(before.token)
    expect(new Date(after.expiresAt).getTime()).toBeGreaterThan(
      new Date(before.expiresAt).getTime(),
    )
  })

  it('expiresInDays 只接受 1 / 7 / 30', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    const bad = await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 3 })
    expect(bad.status).toBe(400)

    const ok = await alice.json(`/api/projects/${projectId}/invite`, 'PATCH', { expiresInDays: 1 })
    expect(ok.status).toBe(200)
  })
})

describe('POST /api/projects/:id/invite/reset', () => {
  it('重置换掉 token，旧链接立刻失效', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const old = (await share(alice, projectId)).invite

    const res = await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})
    expect(res.status).toBe(200)
    const fresh = (await res.json()) as InviteBody
    expect(fresh.token).not.toBe(old.token)

    const stale = await bob.json(`/api/invites/${old.token}/accept`, 'POST')
    expect(stale.status).toBe(404)

    // 新链接照样能用
    expect((await bob.json(`/api/invites/${fresh.token}/accept`, 'POST')).status).toBe(200)
  })

  it('项目始终只有一条分享链接', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)

    await share(alice, projectId)
    await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', {})
    await alice.json(`/api/projects/${projectId}/invite/reset`, 'POST', { expiresInDays: 1 })

    expect(await prisma.projectInvite.count({ where: { projectId } })).toBe(1)
  })
})

describe('GET /api/invites/:token', () => {
  it('预览给出项目名与成员数，不需要先是成员', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice, '设计部')
    const { invite } = await share(alice, projectId)

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
    const { invite } = await share(alice, projectId)

    const res = await alice.request(`/api/invites/${invite.token}`)
    await expect(res.json()).resolves.toMatchObject({ valid: true, alreadyMember: true })
  })

  it('过期 / 重置 / 项目已删各给各的文案', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')

    const expiredProject = await createProject(alice, '过期项目')
    const expired = (await share(alice, expiredProject)).invite
    await expire(expired.token)

    const resetProject = await createProject(alice, '重置项目')
    const beforeReset = (await share(alice, resetProject)).invite
    await alice.json(`/api/projects/${resetProject}/invite/reset`, 'POST', {})

    const read = async (token: string) =>
      (await (await bob.request(`/api/invites/${token}`)).json()) as {
        valid: boolean
        reason: string
        message: string
      }

    expect(await read(expired.token)).toMatchObject({ valid: false, reason: 'expired' })
    // 重置后旧 token 已经不存在了
    expect(await read(beforeReset.token)).toMatchObject({ valid: false, reason: 'not_found' })
    expect(await read('不存在的-token')).toMatchObject({ valid: false, reason: 'not_found' })

    const [expiredText, notFoundText] = await Promise.all(
      [expired.token, '不存在的-token'].map(async (t) => (await read(t)).message),
    )
    expect(expiredText).not.toBe(notFoundText)
  })

  it('项目被软删 → project_deleted', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)
    await alice.request(`/api/projects/${projectId}`, { method: 'DELETE' })

    const res = await bob.request(`/api/invites/${invite.token}`)
    await expect(res.json()).resolves.toMatchObject({ valid: false, reason: 'project_deleted' })
  })

  it('未登录 → 401', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)

    expect((await app.request(`/api/invites/${invite.token}`)).status).toBe(401)
  })
})

describe('POST /api/invites/:token/accept', () => {
  it('接受后成为成员', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)

    const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ projectId })

    expect((await bob.request(`/api/projects/${projectId}`)).status).toBe(200)
  })

  it('同一条链接可以被任意多人使用', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const carol = await actor('carol')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)

    expect((await bob.json(`/api/invites/${invite.token}/accept`, 'POST')).status).toBe(200)
    expect((await carol.json(`/api/invites/${invite.token}/accept`, 'POST')).status).toBe(200)
    expect(await prisma.projectMember.count({ where: { projectId } })).toBe(3)
  })

  it('加入者记录了分享人', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)
    await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

    const member = await prisma.projectMember.findFirst({
      where: { projectId, userId: bob.userId },
    })
    expect(member?.invitedById).toBe(alice.userId)
  })

  it('重复接受是幂等的：不产生第二条成员记录', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)

    await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    const second = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')

    expect(second.status).toBe(200)
    expect(await prisma.projectMember.count({ where: { projectId, userId: bob.userId } })).toBe(1)
  })

  it('过期的链接不能再用', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    const { invite } = await share(alice, projectId)
    await expire(invite.token)

    const res = await bob.json(`/api/invites/${invite.token}/accept`, 'POST')
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ reason: 'expired' })
  })

  it('不存在的 token → 404', async () => {
    const bob = await actor()
    const res = await bob.json('/api/invites/无效/accept', 'POST')
    expect(res.status).toBe(404)
  })
})
