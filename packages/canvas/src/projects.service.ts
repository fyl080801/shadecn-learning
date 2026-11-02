import { randomBytes } from 'node:crypto'
import type {
  InviteInvalidReason,
  InvitePreview,
  ProjectInviteView,
  ProjectKind,
  ProjectMemberView,
  ProjectRole,
  ProjectSummary,
} from '@learning/contracts/canvas'
import { containsIgnoreCase, DataAccess, newId } from '@learning/data-access'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'
import { Flow, Project, ProjectInvite as ProjectInviteRow, ProjectMember } from './entities.js'

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

/** 这里产出的分享链接：接口形状去掉 `url` —— 那个要按**这次请求的访问域名**拼，是路由层的事 */
export type ProjectInvite = Omit<ProjectInviteView, 'url'>

/** 这里产出的邀请预览：接口形状去掉 `message` —— 那句话由路由层按 `reason` 配 */
export type InviteCheck = Omit<InvitePreview, 'message'>

export interface ListProjectsOptions {
  page: number
  pageSize: number
  keyword?: string
}

const toRole = (value: string): ProjectRole => (value === 'admin' ? 'admin' : 'member')
const toKind = (value: string): ProjectKind => (value === 'personal' ? 'personal' : 'team')
const expiryFromNow = (days: InviteExpiryDays) => new Date(Date.now() + days * 24 * 60 * 60 * 1000)

function toInviteView(row: ProjectInviteRow): ProjectInvite {
  return {
    id: row.id,
    projectId: row.project.id,
    token: row.token,
    role: toRole(row.role),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** 一个项目 + 请求者在里面的角色 → 接口形状。计数由调用方查好传进来 */
function toSummary(row: Project, counts: { memberCount: number; flowCount: number }, myRole: string): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: toKind(row.kind),
    memberCount: counts.memberCount,
    flowCount: counts.flowCount,
    myRole: toRole(myRole),
    createdById: row.createdBy.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 项目 / 成员 / 邀请的读写，判权的那半（{@link roleOf}、{@link membershipOf}）也在这里。这里不返回 HTTP 概念的东西，参数校验和状态码在控制器。
 * 接口形状在 `@learning/contracts/canvas`。
 */
@Injectable()
export class ProjectsService {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /** 一批项目各自的成员数、（未软删的）画布数 —— 两次分组计数，不按项目逐个查 */
  private async countsFor(projectIds: string[]): Promise<{ members: Map<string, number>; flows: Map<string, number> }> {
    if (projectIds.length === 0) return { members: new Map(), flows: new Map() }
    const em = this.dataAccess.em()
    const [members, flows] = await Promise.all([
      em.countBy(ProjectMember, 'project', { where: { project: { $in: projectIds } } }),
      em.countBy(Flow, 'project', { where: { project: { $in: projectIds }, deletedAt: null } }),
    ])
    return { members: new Map(Object.entries(members)), flows: new Map(Object.entries(flows)) }
  }

  /**
   * 我参与的项目（软删的不算），按更新时间倒序。
   * **个人空间不在这里**：它不是一个「项目」，不该出现在项目列表里、也不该被搜到（docs/16 §4.5）。
   * 从成员表出发查：「我参与的」就是「有我的成员行的」，顺带拿到我的角色。
   */
  async listForUser(userId: string, options: ListProjectsOptions) {
    const [memberships, total] = await this.dataAccess.em().findAndCount(
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

    const counts = await this.countsFor(memberships.map((row) => row.project.id))
    const items = memberships.map((row) =>
      toSummary(
        row.project,
        { memberCount: counts.members.get(row.project.id) ?? 0, flowCount: counts.flows.get(row.project.id) ?? 0 },
        row.role,
      ),
    )
    return { items, total }
  }

  /** 新建项目：创建者的 admin 成员行在同一个事务里写进去 */
  async create(input: { name: string; description?: string | null; userId: string }): Promise<ProjectSummary> {
    const row = await this.dataAccess.transactional(async (em) => {
      const project = em.create(Project, {
        name: input.name,
        description: input.description ?? null,
        kind: 'team',
        createdBy: input.userId,
        deletedAt: null,
      })
      em.create(ProjectMember, { project, user: input.userId, role: 'admin', invitedById: null })
      return project
    })
    return toSummary(row, { memberCount: 1, flowCount: 0 }, 'admin')
  }

  /** 请求者在项目里的角色；不是成员或项目已软删都返回 null */
  async roleOf(projectId: string, userId: string): Promise<ProjectRole | null> {
    return (await this.membershipOf(projectId, userId))?.role ?? null
  }

  /** 角色 + 项目形态：前者决定能不能干，后者决定这是不是个人空间 */
  async membershipOf(projectId: string, userId: string): Promise<Membership | null> {
    const row = await this.dataAccess
      .em()
      .findOne(ProjectMember, { project: { id: projectId, deletedAt: null }, user: userId }, { populate: ['project'] })
    return row ? { role: toRole(row.role), kind: toKind(row.project.kind) } : null
  }

  /**
   * 拿到我的个人空间，没有就现建一个（docs/16 §3.1）。
   *
   * **懒创建**：登录路径上不做这件事 —— 一个可能永远不会被用到的功能，不值得让每次登录多写一次库。
   *
   * 唯一性由 `Project.personalOwner` 的 unique 约束保证，不靠这里的先查后建：
   * 两个请求同时进来时，输的那个撞 `UniqueConstraintViolationException`，重查一次就拿到赢家建的那条。
   */
  async ensurePersonalSpace(userId: string): Promise<ProjectSummary> {
    const existing = await this.findPersonalSpace(userId)
    if (existing) return existing

    try {
      const row = await this.dataAccess.transactional(async (em) => {
        const project = em.create(Project, {
          name: PERSONAL_SPACE_NAME,
          description: null,
          kind: 'personal',
          personalOwner: userId,
          createdBy: userId,
          deletedAt: null,
        })
        // 成员行照样真实写入：这样判权一行特判都不用加
        em.create(ProjectMember, { project, user: userId, role: 'admin', invitedById: null })
        return project
      })
      return toSummary(row, { memberCount: 1, flowCount: 0 }, 'admin')
    } catch (err) {
      if (!(err instanceof UniqueConstraintViolationException)) throw err
      const raced = await this.findPersonalSpace(userId)
      if (raced) return raced
      throw new Error('个人空间创建失败', { cause: err })
    }
  }

  /** 我的个人空间；没建过返回 null。软删对它不适用（没有删除入口） */
  async findPersonalSpace(userId: string): Promise<ProjectSummary | null> {
    const row = await this.dataAccess.em().findOne(Project, { personalOwner: userId, deletedAt: null }, { fields: ['id'] })
    return row ? this.get(row.id, userId) : null
  }

  /** 详情，只给成员看 */
  async get(projectId: string, userId: string): Promise<ProjectSummary | null> {
    const membership = await this.dataAccess
      .em()
      .findOne(ProjectMember, { project: { id: projectId, deletedAt: null }, user: userId }, { populate: ['project'] })
    if (!membership) return null

    const counts = await this.countsFor([projectId])
    return toSummary(
      membership.project,
      { memberCount: counts.members.get(projectId) ?? 0, flowCount: counts.flows.get(projectId) ?? 0 },
      membership.role,
    )
  }

  async update(projectId: string, userId: string, patch: { name?: string; description?: string | null }) {
    // 直接发 SQL 的更新不触发 onUpdate，updatedAt 得自己写
    await this.dataAccess.em().nativeUpdate(Project, { id: projectId }, { ...patch, updatedAt: new Date() })
    return this.get(projectId, userId)
  }

  /** 软删 —— 只是打个标记，不清理、不提供恢复 */
  async softDelete(projectId: string): Promise<void> {
    const now = new Date()
    await this.dataAccess.em().nativeUpdate(Project, { id: projectId }, { deletedAt: now, updatedAt: now })
  }

  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    const rows = await this.dataAccess.em().find(ProjectMember, { project: projectId }, { populate: ['user'], orderBy: { joinedAt: 'asc' } })
    return rows.map((row) => ({
      userId: row.user.id,
      name: row.user.name,
      username: row.user.username,
      email: row.user.email,
      avatarUrl: row.user.avatarUrl,
      role: toRole(row.role),
      joinedAt: row.joinedAt.toISOString(),
      invitedById: row.invitedById,
    }))
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    return (await this.dataAccess.em().nativeDelete(ProjectMember, { project: projectId, user: userId })) > 0
  }

  /**
   * 拿这个项目的分享链接：没有、或已经过期了就地换一条新的（新 token + 新有效期）。
   * 面板一打开就调它，所以「生成」这个动作对用户是不存在的。过期后不续用旧 token：链接过期的意思就是那串 token 从此作废。
   */
  async ensureInvite(input: { projectId: string; createdById: string; expiresInDays?: InviteExpiryDays }): Promise<ProjectInvite> {
    const current = await this.dataAccess.em().findOne(ProjectInviteRow, { project: input.projectId })
    if (current && current.expiresAt.getTime() > Date.now()) return toInviteView(current)
    return this.resetInvite(input)
  }

  /** 重置：原地换 token，旧链接立刻失效（再打开就是 not_found） */
  async resetInvite(input: { projectId: string; createdById: string; expiresInDays?: InviteExpiryDays }): Promise<ProjectInvite> {
    // 一个项目一条（project 唯一）：没有就插，有就原地换 token / 有效期 / 创建时刻，id 不变。
    // upsert 直接发 SQL，id 和 createdAt 不会自动生成，得自己给
    await this.dataAccess.em().upsert(
      ProjectInviteRow,
      {
        id: newId(),
        project: input.projectId,
        token: randomBytes(32).toString('base64url'),
        role: 'member',
        createdById: input.createdById,
        createdAt: new Date(),
        expiresAt: expiryFromNow(input.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS),
      },
      { onConflictFields: ['project'], onConflictMergeFields: ['token', 'createdById', 'createdAt', 'expiresAt'] },
    )
    // 重读一遍：upsert 撞上已有行时返回的实体未必带齐库里的每一列
    return toInviteView(await this.dataAccess.em().findOneOrFail(ProjectInviteRow, { project: input.projectId }))
  }

  /** 只改有效期，token 不动 —— 已经发出去的链接不该因为续期而失效 */
  async setInviteExpiry(input: { projectId: string; createdById: string; expiresInDays: InviteExpiryDays }): Promise<ProjectInvite> {
    const em = this.dataAccess.em()
    const current = await em.findOne(ProjectInviteRow, { project: input.projectId })
    // 没有链接（或已过期）时「改有效期」等同于重新生成一条
    if (!current || current.expiresAt.getTime() <= Date.now()) return this.resetInvite(input)

    await em.nativeUpdate(ProjectInviteRow, { project: input.projectId }, { expiresAt: expiryFromNow(input.expiresInDays) })
    return toInviteView(await this.dataAccess.em().findOneOrFail(ProjectInviteRow, { project: input.projectId }))
  }

  /** 分享链接预览：访问者此刻还不是成员，所以这里只按 token 判断 */
  async previewInvite(token: string, userId: string): Promise<InviteCheck> {
    const em = this.dataAccess.em()
    const invite = await em.findOne(ProjectInviteRow, { token }, { populate: ['project'] })
    if (!invite) return { valid: false, reason: 'not_found', alreadyMember: false }

    const projectId = invite.project.id
    const [memberCount, mine] = await Promise.all([
      em.count(ProjectMember, { project: projectId }),
      em.count(ProjectMember, { project: projectId, user: userId }),
    ])
    const alreadyMember = mine > 0
    const base = { projectId, projectName: invite.project.name, memberCount, alreadyMember }

    if (invite.project.deletedAt) return { valid: false, reason: 'project_deleted', ...base }
    // 已经是成员的话，链接失没失效都不影响他进项目
    if (alreadyMember) return { valid: true, ...base }
    if (invite.expiresAt.getTime() <= Date.now()) return { valid: false, reason: 'expired', ...base }
    if (base.memberCount >= PROJECT_LIMITS.members) return { valid: false, reason: 'project_full', ...base }

    return { valid: true, ...base }
  }

  /**
   * 通过分享链接加入。已经是成员时幂等返回，不会写第二条成员记录。
   * 同一个人并发接受时靠 `(project, user)` 的唯一约束：输的那个已经是成员了，同样算成功。
   */
  async acceptInvite(token: string, userId: string): Promise<{ ok: true; projectId: string } | { ok: false; reason: InviteInvalidReason }> {
    const preview = await this.previewInvite(token, userId)
    if (!preview.valid || !preview.projectId) return { ok: false, reason: preview.reason ?? 'not_found' }
    if (preview.alreadyMember) return { ok: true, projectId: preview.projectId }

    const em = this.dataAccess.em()
    const invite = await em.findOne(ProjectInviteRow, { token })
    if (!invite) return { ok: false, reason: 'not_found' }

    em.create(ProjectMember, { project: invite.project, user: userId, role: invite.role, invitedById: invite.createdById })
    try {
      await em.flush()
    } catch (err) {
      if (!(err instanceof UniqueConstraintViolationException)) throw err
    }
    return { ok: true, projectId: invite.project.id }
  }

  countMembers(projectId: string): Promise<number> {
    return this.dataAccess.em().count(ProjectMember, { project: projectId })
  }
}
