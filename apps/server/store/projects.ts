import crypto from 'node:crypto'
import { prisma } from '../db.ts'
import { nameContains } from './text.ts'

/**
 * 项目 / 成员 / 邀请的数据访问层。
 * 路由层只做参数校验和状态码，这里不返回 HTTP 概念的东西。
 */

export type ProjectRole = 'admin' | 'member'

/**
 * 项目的两种形态（REQ-SOLO）。
 *
 * - `team` —— 正常项目：有成员、有分享链接，里面的画布走协同。
 * - `personal` —— 每人一个的私人空间：只有自己一个成员、没有分享链接，
 *   里面的画布**不走协同**（`mode = 'solo'`）。
 *
 * 画布的 mode 由它派生，不在 `Flow` 上另存一份 —— 存两处必然漂移。
 */
export type ProjectKind = 'team' | 'personal'

/** 个人空间的名字。界面上不展示，也不给改 —— 它不是一个「项目」 */
const PERSONAL_SPACE_NAME = '我的画布'

export const PROJECT_LIMITS = {
  members: 200,
  /** 只对团队项目生效：个人空间是自己的草稿箱，不设上限（docs/16 §4.5） */
  flows: 500,
} as const

/** 分享链接有效期只接受这几个档 */
export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number]
export const DEFAULT_INVITE_EXPIRY_DAYS: InviteExpiryDays = 7

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  /** team | personal —— personal 里的画布不走协同 */
  kind: ProjectKind
  memberCount: number
  flowCount: number
  /** 当前请求者在这个项目里的角色 */
  myRole: ProjectRole
  createdById: string
  createdAt: string
  updatedAt: string
}

/** 一个人在某个项目里的身份 —— 角色 + 这是哪种项目，一次查询取齐 */
export interface Membership {
  role: ProjectRole
  kind: ProjectKind
}

export interface ProjectMemberView {
  userId: string
  name: string | null
  username: string | null
  email: string | null
  avatarUrl: string | null
  role: ProjectRole
  joinedAt: string
  invitedById: string | null
}

export interface ProjectInviteView {
  id: string
  projectId: string
  token: string
  role: ProjectRole
  createdById: string
  createdAt: string
  expiresAt: string
}

export type InviteInvalidReason = 'not_found' | 'expired' | 'project_deleted' | 'project_full'

export interface InvitePreview {
  valid: boolean
  reason?: InviteInvalidReason
  projectId?: string
  projectName?: string
  memberCount?: number
  /** 已经是成员了 —— 前端把按钮换成「进入项目」 */
  alreadyMember: boolean
}

export interface ListProjectsOptions {
  page: number
  pageSize: number
  keyword?: string
}

function toRole(value: string): ProjectRole {
  return value === 'admin' ? 'admin' : 'member'
}

function toKind(value: string): ProjectKind {
  return value === 'personal' ? 'personal' : 'team'
}

function iso(value: Date): string {
  return value.toISOString()
}

function expiryFromNow(days: InviteExpiryDays): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function toInviteView(row: {
  id: string
  projectId: string
  token: string
  role: string
  createdById: string
  createdAt: Date
  expiresAt: Date
}): ProjectInviteView {
  return {
    id: row.id,
    projectId: row.projectId,
    token: row.token,
    role: toRole(row.role),
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  }
}

export const projects = {
  /**
   * 我参与的项目（软删的不算），按更新时间倒序。
   *
   * **个人空间不在这里**：它不是一个「项目」，不该出现在项目列表里、也不该被搜到 ——
   * 它在同一个页面的另一个 Tab 里直接列画布（docs/16 §4.8）。
   */
  async listForUser(userId: string, options: ListProjectsOptions) {
    const where = {
      deletedAt: null,
      kind: 'team',
      members: { some: { userId } },
      ...(options.keyword ? { name: nameContains(options.keyword) } : {}),
    }

    const [total, rows] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        include: {
          members: { where: { userId }, select: { role: true } },
          _count: { select: { members: true } },
        },
      }),
    ])

    // 画布数要排掉软删的，_count 做不到条件计数，单独查一次再拼回去
    const flowCounts = await prisma.flow.groupBy({
      by: ['projectId'],
      where: { projectId: { in: rows.map((row) => row.id) }, deletedAt: null },
      _count: { _all: true },
    })
    const flowCountBy = new Map(flowCounts.map((row) => [row.projectId, row._count._all]))

    const items: ProjectSummary[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      kind: toKind(row.kind),
      memberCount: row._count.members,
      flowCount: flowCountBy.get(row.id) ?? 0,
      myRole: toRole(row.members[0]?.role ?? 'member'),
      createdById: row.createdById,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }))

    return { items, total }
  },

  /** 新建项目：创建者的 admin 成员行在同一个事务里写进去 */
  async create(input: { name: string; description?: string | null; userId: string }) {
    const row = await prisma.project.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        createdById: input.userId,
        members: { create: { userId: input.userId, role: 'admin' } },
      },
    })

    const summary: ProjectSummary = {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: toKind(row.kind),
      memberCount: 1,
      flowCount: 0,
      myRole: 'admin',
      createdById: row.createdById,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }
    return summary
  },

  /** 请求者在项目里的角色；不是成员或项目已软删都返回 null */
  async roleOf(projectId: string, userId: string): Promise<ProjectRole | null> {
    return (await this.membershipOf(projectId, userId))?.role ?? null
  },

  /**
   * 角色 + 项目形态，一次查询取齐。
   *
   * 鉴权中间件要的就是这两样：前者决定能不能干，后者决定这是不是个人空间
   * （个人空间上不许有分享链接、成员管理这些动作）。
   */
  async membershipOf(projectId: string, userId: string): Promise<Membership | null> {
    const row = await prisma.projectMember.findFirst({
      where: { projectId, userId, project: { deletedAt: null } },
      select: { role: true, project: { select: { kind: true } } },
    })
    return row ? { role: toRole(row.role), kind: toKind(row.project.kind) } : null
  },

  /**
   * 拿到我的个人空间，没有就现建一个（REQ-SOLO）。
   *
   * **懒创建**：登录路径上不做这件事 —— 一个可能永远不会被用到的功能，不值得
   * 让每次登录多写一次库。第一次点进「个人画布」时才建。
   *
   * 唯一性由 `Project.personalOwnerId` 的 unique 约束保证，不靠这里的先查后建：
   * 两个请求同时进来时，输的那个会撞 P2002，重查一次就拿到赢家建的那条。
   */
  async ensurePersonalSpace(userId: string): Promise<ProjectSummary> {
    const existing = await this.findPersonalSpace(userId)
    if (existing) return existing

    try {
      const row = await prisma.project.create({
        data: {
          name: PERSONAL_SPACE_NAME,
          kind: 'personal',
          personalOwnerId: userId,
          createdById: userId,
          // 成员行照样真实写入：这样 roleOf / requireProjectMember 一行特判都不用加
          members: { create: { userId, role: 'admin' } },
        },
      })

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        kind: 'personal',
        memberCount: 1,
        flowCount: 0,
        myRole: 'admin',
        createdById: row.createdById,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }
    } catch {
      // 并发下输掉的那个：赢家已经建好了，重查即可。查不到才是真的出了问题
      const raced = await this.findPersonalSpace(userId)
      if (raced) return raced
      throw new Error('个人空间创建失败')
    }
  },

  /** 我的个人空间；没建过返回 null。软删对它不适用（没有删除入口） */
  async findPersonalSpace(userId: string): Promise<ProjectSummary | null> {
    const row = await prisma.project.findFirst({
      where: { personalOwnerId: userId, deletedAt: null },
      select: { id: true },
    })
    return row ? this.get(row.id, userId) : null
  },

  /** 详情，只给成员看 */
  async get(projectId: string, userId: string): Promise<ProjectSummary | null> {
    const row = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, members: { some: { userId } } },
      include: {
        members: { where: { userId }, select: { role: true } },
        _count: { select: { members: true } },
      },
    })
    if (!row) return null

    const flowCount = await prisma.flow.count({ where: { projectId, deletedAt: null } })

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: toKind(row.kind),
      memberCount: row._count.members,
      flowCount,
      myRole: toRole(row.members[0]?.role ?? 'member'),
      createdById: row.createdById,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }
  },

  async update(
    projectId: string,
    userId: string,
    patch: { name?: string; description?: string | null },
  ) {
    await prisma.project.update({ where: { id: projectId }, data: patch })
    return this.get(projectId, userId)
  },

  /** 软删 —— 只是打个标记，不清理、不提供恢复 */
  async softDelete(projectId: string) {
    await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } })
  },

  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    const rows = await prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: { select: { name: true, username: true, email: true, avatarUrl: true } },
      },
    })

    return rows.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      username: row.user.username,
      email: row.user.email,
      avatarUrl: row.user.avatarUrl,
      role: toRole(row.role),
      joinedAt: iso(row.joinedAt),
      invitedById: row.invitedById,
    }))
  },

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const result = await prisma.projectMember.deleteMany({ where: { projectId, userId } })
    return result.count > 0
  },

  /**
   * 拿这个项目的分享链接：没有、或已经过期了就地换一条新的（新 token + 新有效期）。
   * 面板一打开就调它，所以「生成」这个动作对用户是不存在的 —— 打开即有链接。
   * 过期后不续用旧 token：链接过期的意思就是那串 token 从此作废。
   */
  async ensureInvite(input: {
    projectId: string
    createdById: string
    expiresInDays?: InviteExpiryDays
  }): Promise<ProjectInviteView> {
    const current = await prisma.projectInvite.findUnique({
      where: { projectId: input.projectId },
    })
    if (current && current.expiresAt.getTime() > Date.now()) return toInviteView(current)

    return this.resetInvite(input)
  },

  /** 重置：原地换 token，旧链接立刻失效（再打开就是 not_found） */
  async resetInvite(input: {
    projectId: string
    createdById: string
    expiresInDays?: InviteExpiryDays
  }): Promise<ProjectInviteView> {
    const data = {
      token: crypto.randomBytes(32).toString('base64url'),
      createdById: input.createdById,
      expiresAt: expiryFromNow(input.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS),
    }

    const row = await prisma.projectInvite.upsert({
      where: { projectId: input.projectId },
      create: { projectId: input.projectId, ...data },
      update: { ...data, createdAt: new Date() },
    })
    return toInviteView(row)
  },

  /** 只改有效期，token 不动 —— 已经发出去的链接不该因为续期而失效 */
  async setInviteExpiry(input: {
    projectId: string
    createdById: string
    expiresInDays: InviteExpiryDays
  }): Promise<ProjectInviteView> {
    const current = await prisma.projectInvite.findUnique({
      where: { projectId: input.projectId },
    })
    // 没有链接（或已过期）时「改有效期」等同于重新生成一条
    if (!current || current.expiresAt.getTime() <= Date.now()) return this.resetInvite(input)

    const row = await prisma.projectInvite.update({
      where: { projectId: input.projectId },
      data: { expiresAt: expiryFromNow(input.expiresInDays) },
    })
    return toInviteView(row)
  },

  /** 分享链接预览：访问者此刻还不是成员，所以这里只按 token 判断 */
  async previewInvite(token: string, userId: string): Promise<InvitePreview> {
    const invite = await prisma.projectInvite.findUnique({
      where: { token },
      include: { project: { include: { _count: { select: { members: true } } } } },
    })
    if (!invite) return { valid: false, reason: 'not_found', alreadyMember: false }

    const alreadyMember =
      (await prisma.projectMember.count({ where: { projectId: invite.projectId, userId } })) > 0

    const base = {
      projectId: invite.projectId,
      projectName: invite.project.name,
      memberCount: invite.project._count.members,
      alreadyMember,
    }

    if (invite.project.deletedAt) return { valid: false, reason: 'project_deleted', ...base }
    // 已经是成员的话，链接失没失效都不影响他进项目
    if (alreadyMember) return { valid: true, ...base }
    if (invite.expiresAt.getTime() <= Date.now()) return { valid: false, reason: 'expired', ...base }
    if (base.memberCount >= PROJECT_LIMITS.members) {
      return { valid: false, reason: 'project_full', ...base }
    }

    return { valid: true, ...base }
  },

  /** 通过分享链接加入。已经是成员时幂等返回，不会写第二条成员记录。 */
  async acceptInvite(
    token: string,
    userId: string,
  ): Promise<{ ok: true; projectId: string } | { ok: false; reason: InviteInvalidReason }> {
    const preview = await this.previewInvite(token, userId)
    if (!preview.valid || !preview.projectId) {
      return { ok: false, reason: preview.reason ?? 'not_found' }
    }
    if (preview.alreadyMember) return { ok: true, projectId: preview.projectId }

    const invite = await prisma.projectInvite.findUnique({ where: { token } })
    if (!invite) return { ok: false, reason: 'not_found' }

    await prisma.projectMember.create({
      data: {
        projectId: invite.projectId,
        userId,
        role: invite.role,
        invitedById: invite.createdById,
      },
    })

    return { ok: true, projectId: invite.projectId }
  },

  countMembers(projectId: string) {
    return prisma.projectMember.count({ where: { projectId } })
  },
}
