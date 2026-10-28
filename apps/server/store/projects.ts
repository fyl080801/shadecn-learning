import crypto from 'node:crypto'
import type {
  InviteInvalidReason,
  InvitePreview,
  ProjectInviteView,
  ProjectKind,
  ProjectMemberView,
  ProjectRole,
  ProjectSummary,
} from '@shadecn/shared/canvas'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { db } from '../db.ts'
import {
  Flow,
  newId,
  Project,
  ProjectInvite as ProjectInviteRow,
  ProjectMember,
} from '../db/entities/index.ts'
import { containsIgnoreCase } from '../db/query.ts'

/**
 * 项目 / 成员 / 邀请的数据访问层。
 * 路由层只做参数校验和状态码，这里不返回 HTTP 概念的东西。
 *
 * 接口形状在 `@shadecn/shared/canvas`，前端消费的是同一份；这里转出去，服务端各处照旧从本模块取。
 */

export type {
  InviteInvalidReason,
  ProjectKind,
  ProjectMemberView,
  ProjectRole,
  ProjectSummary,
}

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

/** 一个人在某个项目里的身份 —— 角色 + 这是哪种项目，一次查询取齐 */
export interface Membership {
  role: ProjectRole
  kind: ProjectKind
}

/**
 * store 层产出的分享链接：接口形状去掉 `url` —— 那个要按**这次请求的访问域名**拼，
 * 是路由层的事（`routes/projects.ts` 的 `withUrl`）。
 */
export type ProjectInvite = Omit<ProjectInviteView, 'url'>

/** store 层产出的邀请预览：接口形状去掉 `message` —— 那句话由路由层按 `reason` 配（`routes/invites.ts`） */
export type InviteCheck = Omit<InvitePreview, 'message'>

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

function toInviteView(row: ProjectInviteRow): ProjectInvite {
  return {
    id: row.id,
    projectId: row.project.id,
    token: row.token,
    role: toRole(row.role),
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  }
}

/** 一个项目 + 请求者在里面的角色 → 接口形状。计数由调用方查好传进来 */
function toSummary(
  row: Project,
  counts: { memberCount: number; flowCount: number },
  myRole: string,
): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: toKind(row.kind),
    memberCount: counts.memberCount,
    flowCount: counts.flowCount,
    myRole: toRole(myRole),
    createdById: row.createdBy.id,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

/** 一批项目各自的成员数、（未软删的）画布数 —— 两次分组计数，不按项目逐个查 */
async function countsFor(
  projectIds: string[],
): Promise<{ members: Map<string, number>; flows: Map<string, number> }> {
  if (projectIds.length === 0) return { members: new Map(), flows: new Map() }
  const em = db()
  const [members, flowCounts] = await Promise.all([
    em.countBy(ProjectMember, 'project', { where: { project: { $in: projectIds } } }),
    em.countBy(Flow, 'project', { where: { project: { $in: projectIds }, deletedAt: null } }),
  ])
  return { members: new Map(Object.entries(members)), flows: new Map(Object.entries(flowCounts)) }
}

export const projects = {
  /**
   * 我参与的项目（软删的不算），按更新时间倒序。
   *
   * **个人空间不在这里**：它不是一个「项目」，不该出现在项目列表里、也不该被搜到 ——
   * 它有自己的页面（`/personal`），直接列画布（docs/16 §4.8）。
   *
   * 从成员表出发查：「我参与的」就是「有我的成员行的」，顺带拿到我的角色。
   */
  async listForUser(userId: string, options: ListProjectsOptions) {
    const [memberships, total] = await db().findAndCount(
      ProjectMember,
      {
        user: userId,
        project: {
          deletedAt: null,
          kind: 'team',
          ...(options.keyword ? containsIgnoreCase('name', options.keyword) : {}),
        },
      },
      {
        populate: ['project'],
        orderBy: { project: { updatedAt: 'desc' } },
        offset: (options.page - 1) * options.pageSize,
        limit: options.pageSize,
      },
    )

    const counts = await countsFor(memberships.map((row) => row.project.id))
    const items = memberships.map((row) =>
      toSummary(
        row.project,
        {
          memberCount: counts.members.get(row.project.id) ?? 0,
          flowCount: counts.flows.get(row.project.id) ?? 0,
        },
        row.role,
      ),
    )

    return { items, total }
  },

  /** 新建项目：创建者的 admin 成员行在同一个事务里写进去 */
  async create(input: { name: string; description?: string | null; userId: string }) {
    const row = await db().transactional(async (em) => {
      const project = em.create(Project, {
        name: input.name,
        description: input.description ?? null,
        kind: 'team',
        createdBy: input.userId,
      })
      em.create(ProjectMember, { project, user: input.userId, role: 'admin' })
      return project
    })

    return toSummary(row, { memberCount: 1, flowCount: 0 }, 'admin')
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
    const row = await db().findOne(
      ProjectMember,
      { project: { id: projectId, deletedAt: null }, user: userId },
      { populate: ['project'] },
    )
    return row ? { role: toRole(row.role), kind: toKind(row.project.kind) } : null
  },

  /**
   * 拿到我的个人空间，没有就现建一个（REQ-SOLO）。
   *
   * **懒创建**：登录路径上不做这件事 —— 一个可能永远不会被用到的功能，不值得
   * 让每次登录多写一次库。第一次点进「个人画布」时才建。
   *
   * 唯一性由 `Project.personalOwner` 的 unique 约束保证，不靠这里的先查后建：
   * 两个请求同时进来时，输的那个会撞 `UniqueConstraintViolationException`，
   * 重查一次就拿到赢家建的那条。
   */
  async ensurePersonalSpace(userId: string): Promise<ProjectSummary> {
    const existing = await this.findPersonalSpace(userId)
    if (existing) return existing

    try {
      const row = await db().transactional(async (em) => {
        const project = em.create(Project, {
          name: PERSONAL_SPACE_NAME,
          description: null,
          kind: 'personal',
          personalOwner: userId,
          createdBy: userId,
        })
        // 成员行照样真实写入：这样 roleOf / requireProjectMember 一行特判都不用加
        em.create(ProjectMember, { project, user: userId, role: 'admin' })
        return project
      })

      return toSummary(row, { memberCount: 1, flowCount: 0 }, 'admin')
    } catch (err) {
      // 并发下输掉的那个：赢家已经建好了，重查即可。别的错误照常抛
      if (!(err instanceof UniqueConstraintViolationException)) throw err
      const raced = await this.findPersonalSpace(userId)
      if (raced) return raced
      throw new Error('个人空间创建失败', { cause: err })
    }
  },

  /** 我的个人空间；没建过返回 null。软删对它不适用（没有删除入口） */
  async findPersonalSpace(userId: string): Promise<ProjectSummary | null> {
    const row = await db().findOne(
      Project,
      { personalOwner: userId, deletedAt: null },
      { fields: ['id'] },
    )
    return row ? this.get(row.id, userId) : null
  },

  /** 详情，只给成员看 */
  async get(projectId: string, userId: string): Promise<ProjectSummary | null> {
    const membership = await db().findOne(
      ProjectMember,
      { project: { id: projectId, deletedAt: null }, user: userId },
      { populate: ['project'] },
    )
    if (!membership) return null

    const counts = await countsFor([projectId])
    return toSummary(
      membership.project,
      {
        memberCount: counts.members.get(projectId) ?? 0,
        flowCount: counts.flows.get(projectId) ?? 0,
      },
      membership.role,
    )
  },

  async update(
    projectId: string,
    userId: string,
    patch: { name?: string; description?: string | null },
  ) {
    // 直接发 SQL 的更新不触发 onUpdate，updatedAt 得自己写
    await db().nativeUpdate(Project, { id: projectId }, { ...patch, updatedAt: new Date() })
    return this.get(projectId, userId)
  },

  /** 软删 —— 只是打个标记，不清理、不提供恢复 */
  async softDelete(projectId: string) {
    const now = new Date()
    await db().nativeUpdate(Project, { id: projectId }, { deletedAt: now, updatedAt: now })
  },

  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    const rows = await db().find(
      ProjectMember,
      { project: projectId },
      { populate: ['user'], orderBy: { joinedAt: 'asc' } },
    )

    return rows.map((row) => ({
      userId: row.user.id,
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
    const count = await db().nativeDelete(ProjectMember, { project: projectId, user: userId })
    return count > 0
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
  }): Promise<ProjectInvite> {
    const current = await db().findOne(ProjectInviteRow, { project: input.projectId })
    if (current && current.expiresAt.getTime() > Date.now()) return toInviteView(current)

    return this.resetInvite(input)
  },

  /** 重置：原地换 token，旧链接立刻失效（再打开就是 not_found） */
  async resetInvite(input: {
    projectId: string
    createdById: string
    expiresInDays?: InviteExpiryDays
  }): Promise<ProjectInvite> {
    const em = db()
    // 一个项目一条（project 唯一）：没有就插，有就原地换 token / 有效期 / 创建时刻，id 不变。
    // upsert 直接发 SQL，id 和 createdAt 不会自动生成，得自己给
    await em.upsert(
      ProjectInviteRow,
      {
        id: newId(),
        project: input.projectId,
        token: crypto.randomBytes(32).toString('base64url'),
        role: 'member',
        createdById: input.createdById,
        createdAt: new Date(),
        expiresAt: expiryFromNow(input.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS),
      },
      {
        onConflictFields: ['project'],
        onConflictMergeFields: ['token', 'createdById', 'createdAt', 'expiresAt'],
      },
    )
    // 重读一遍：upsert 撞上已有行时返回的实体未必带齐库里的每一列
    return toInviteView(await db().findOneOrFail(ProjectInviteRow, { project: input.projectId }))
  },

  /** 只改有效期，token 不动 —— 已经发出去的链接不该因为续期而失效 */
  async setInviteExpiry(input: {
    projectId: string
    createdById: string
    expiresInDays: InviteExpiryDays
  }): Promise<ProjectInvite> {
    const current = await db().findOne(ProjectInviteRow, { project: input.projectId })
    // 没有链接（或已过期）时「改有效期」等同于重新生成一条
    if (!current || current.expiresAt.getTime() <= Date.now()) return this.resetInvite(input)

    await db().nativeUpdate(
      ProjectInviteRow,
      { project: input.projectId },
      { expiresAt: expiryFromNow(input.expiresInDays) },
    )
    return toInviteView(await db().findOneOrFail(ProjectInviteRow, { project: input.projectId }))
  },

  /** 分享链接预览：访问者此刻还不是成员，所以这里只按 token 判断 */
  async previewInvite(token: string, userId: string): Promise<InviteCheck> {
    const em = db()
    const invite = await em.findOne(ProjectInviteRow, { token }, { populate: ['project'] })
    if (!invite) return { valid: false, reason: 'not_found', alreadyMember: false }

    const projectId = invite.project.id
    const [memberCount, mine] = await Promise.all([
      em.count(ProjectMember, { project: projectId }),
      em.count(ProjectMember, { project: projectId, user: userId }),
    ])
    const alreadyMember = mine > 0

    const base = {
      projectId,
      projectName: invite.project.name,
      memberCount,
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

    const em = db()
    const invite = await em.findOne(ProjectInviteRow, { token })
    if (!invite) return { ok: false, reason: 'not_found' }

    em.create(ProjectMember, {
      project: invite.project,
      user: userId,
      role: invite.role,
      invitedById: invite.createdById,
    })
    await em.flush()

    return { ok: true, projectId: invite.project.id }
  },

  countMembers(projectId: string) {
    return db().count(ProjectMember, { project: projectId })
  },
}
