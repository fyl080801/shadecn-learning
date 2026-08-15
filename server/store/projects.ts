import crypto from 'node:crypto'
import { prisma } from '../db.ts'

/**
 * 项目 / 成员 / 邀请的数据访问层。
 * 路由层只做参数校验和状态码，这里不返回 HTTP 概念的东西。
 */

export type ProjectRole = 'admin' | 'member'

export const PROJECT_LIMITS = {
  members: 200,
  flows: 500,
  /** 单项目同时有效的邀请数 */
  invites: 20,
} as const

/** 邀请有效期只接受这几个档 */
export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number]

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  memberCount: number
  flowCount: number
  /** 当前请求者在这个项目里的角色 */
  myRole: ProjectRole
  createdById: string
  createdAt: string
  updatedAt: string
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
  maxUses: number | null
  usedCount: number
  revokedAt: string | null
}

export type InviteInvalidReason =
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'exhausted'
  | 'project_deleted'
  | 'project_full'

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

function iso(value: Date): string {
  return value.toISOString()
}

export const projects = {
  /** 我参与的项目（软删的不算），按更新时间倒序 */
  async listForUser(userId: string, options: ListProjectsOptions) {
    const where = {
      deletedAt: null,
      members: { some: { userId } },
      ...(options.keyword ? { name: { contains: options.keyword } } : {}),
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
    const row = await prisma.projectMember.findFirst({
      where: { projectId, userId, project: { deletedAt: null } },
      select: { role: true },
    })
    return row ? toRole(row.role) : null
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

  /** 当前有效（未撤销、未过期、次数没用完）的邀请 */
  async listInvites(projectId: string): Promise<ProjectInviteView[]> {
    const rows = await prisma.projectInvite.findMany({
      where: { projectId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    })

    return rows
      .filter((row) => row.maxUses === null || row.usedCount < row.maxUses)
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        token: row.token,
        role: toRole(row.role),
        createdById: row.createdById,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        maxUses: row.maxUses,
        usedCount: row.usedCount,
        revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
      }))
  },

  async createInvite(input: {
    projectId: string
    createdById: string
    expiresInDays: InviteExpiryDays
    maxUses: number | null
  }): Promise<ProjectInviteView> {
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    const row = await prisma.projectInvite.create({
      data: {
        projectId: input.projectId,
        token: crypto.randomBytes(32).toString('base64url'),
        createdById: input.createdById,
        expiresAt,
        maxUses: input.maxUses,
      },
    })

    return {
      id: row.id,
      projectId: row.projectId,
      token: row.token,
      role: toRole(row.role),
      createdById: row.createdById,
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      revokedAt: null,
    }
  },

  async revokeInvite(projectId: string, inviteId: string): Promise<boolean> {
    const result = await prisma.projectInvite.updateMany({
      where: { id: inviteId, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return result.count > 0
  },

  /** 邀请预览：被邀请者此刻还不是成员，所以这里只按 token 判断 */
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
    if (invite.revokedAt) return { valid: false, reason: 'revoked', ...base }
    if (invite.expiresAt.getTime() <= Date.now()) return { valid: false, reason: 'expired', ...base }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      return { valid: false, reason: 'exhausted', ...base }
    }
    if (base.memberCount >= PROJECT_LIMITS.members) {
      return { valid: false, reason: 'project_full', ...base }
    }

    return { valid: true, ...base }
  },

  /**
   * 接受邀请。已经是成员时幂等返回，且**不涨 usedCount** ——
   * 重复点「加入」不应该把一张限次邀请刷掉。
   */
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

    await prisma.$transaction([
      prisma.projectMember.create({
        data: {
          projectId: invite.projectId,
          userId,
          role: invite.role,
          invitedById: invite.createdById,
        },
      }),
      prisma.projectInvite.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      }),
    ])

    return { ok: true, projectId: invite.projectId }
  },

  countMembers(projectId: string) {
    return prisma.projectMember.count({ where: { projectId } })
  },

  countActiveInvites(projectId: string) {
    return prisma.projectInvite.count({
      where: { projectId, revokedAt: null, expiresAt: { gt: new Date() } },
    })
  },
}
