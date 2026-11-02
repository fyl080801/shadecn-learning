import type { FlowStatus, ProjectSummary } from '@learning/contracts/canvas'
import { CurrentUser, RequestOrigins, type OriginRequest, type SessionUser } from '@learning/session'
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { AccessRevocation } from './access-revocation.js'
import { FLOW_STATUSES, type FlowSort, FlowsService } from './flows.service.js'
import { type CanvasAccess, CurrentAccess, ProjectMemberGuard, TeamProjectAdmin } from './guards.js'
import { badRequest, jsonBody, parseDescription, parseName, parsePagination, queryText, unwrap } from './params.js'
import { DEFAULT_INVITE_EXPIRY_DAYS, INVITE_EXPIRY_DAYS, type InviteExpiryDays, PROJECT_LIMITS, ProjectsService } from './projects.service.js'

interface ProjectPayload {
  name?: unknown
  description?: unknown
}

interface InvitePayload {
  expiresInDays?: unknown
}

function parseExpiry(raw: unknown): InviteExpiryDays {
  if (!INVITE_EXPIRY_DAYS.includes(raw as InviteExpiryDays)) throw badRequest(`expiresInDays 只能是 ${INVITE_EXPIRY_DAYS.join(' / ')}`)
  return raw as InviteExpiryDays
}

function parseSort(raw: string | undefined): { sort: FlowSort; order: 'asc' | 'desc' } {
  if (!raw) return { sort: 'updatedAt', order: 'desc' }
  const [field, direction = 'desc'] = raw.split(':')
  if ((field !== 'updatedAt' && field !== 'createdAt' && field !== 'name') || (direction !== 'asc' && direction !== 'desc')) {
    throw badRequest('sort 只支持 updatedAt / createdAt / name 加 :asc|:desc')
  }
  return { sort: field, order: direction }
}

const projectNotFound = () => new HttpException({ error: 'Not Found', message: '项目不存在' }, 404)

/**
 * `/api/projects`：项目、成员、分享链接、项目内的画布。形状和错误文案以 `apps/web/src/lib/api.ts` 读取的为准（docs/13）。
 * 登录由全局的 `ApiSessionGuard` 负责；`/:projectId*` 要求是成员，不是成员一律 404。
 *
 * 个人空间在接口层就是个项目：拿到 `/personal` 给的 id 之后，列表 / 新建 / 改名 / 删除全都复用 `/:projectId/flows` 那几条（docs/16 §4.2）。
 */
@Controller('api/projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(AccessRevocation) private readonly revocation: AccessRevocation,
    @Inject(RequestOrigins) private readonly origins: RequestOrigins,
  ) {}

  /** 把分享链接拼成前端能直接复制的完整 URL。域名跟着**当前这次请求**走（白名单收口）：管理员从哪个域名打开的分享框，复制出去的链接就是那个域名 */
  private withUrl<T extends { token: string }>(request: OriginRequest, invite: T) {
    return { ...invite, url: `${this.origins.of(request)}/invite/${invite.token}` }
  }

  @Get()
  async list(@CurrentUser() user: SessionUser, @Query() query: Record<string, unknown>) {
    const paged = unwrap(parsePagination(query))
    const { items, total } = await this.projects.listForUser(user.id, { ...paged, keyword: queryText(query.keyword)?.trim() || undefined })
    return { items, ...paged, total, totalPages: Math.ceil(total / paged.pageSize) }
  }

  @Post()
  create(@CurrentUser() user: SessionUser, @Body() raw: unknown): Promise<ProjectSummary> {
    const body = jsonBody<ProjectPayload>(raw)
    const name = unwrap(parseName(body.name))
    const description = unwrap(parseDescription(body.description ?? null))
    return this.projects.create({ name, description, userId: user.id })
  }

  /** 我的个人空间：读接口也会建，第一次点进「个人画布」就有了（docs/16 §3.1）。Fastify 的静态路径优先于 `:projectId`，所以和方法的先后无关 */
  @Get('personal')
  personal(@CurrentUser() user: SessionUser): Promise<ProjectSummary> {
    return this.projects.ensurePersonalSpace(user.id)
  }

  @Get(':projectId')
  @UseGuards(ProjectMemberGuard)
  async get(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess): Promise<ProjectSummary> {
    const project = await this.projects.get(access.projectId, user.id)
    if (!project) throw projectNotFound()
    return project
  }

  @Patch(':projectId')
  @TeamProjectAdmin()
  async update(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Body() raw: unknown): Promise<ProjectSummary> {
    const body = jsonBody<ProjectPayload>(raw)
    const patch: { name?: string; description?: string | null } = {}
    if (body.name !== undefined) patch.name = unwrap(parseName(body.name))
    if (body.description !== undefined) patch.description = unwrap(parseDescription(body.description))

    const project = await this.projects.update(access.projectId, user.id, patch)
    if (!project) throw projectNotFound()
    return project
  }

  @Delete(':projectId')
  @HttpCode(204)
  @TeamProjectAdmin()
  async remove(@CurrentAccess() access: CanvasAccess): Promise<void> {
    await this.projects.softDelete(access.projectId)
    // 项目没了，它下面画布的房间也就没人有权待着：当场断掉，别等轮询
    await this.revocation.revoke()
  }

  @Get(':projectId/members')
  @UseGuards(ProjectMemberGuard)
  members(@CurrentAccess() access: CanvasAccess) {
    return this.projects.listMembers(access.projectId)
  }

  /**
   * 不能移除自己，这也是「项目至少留一个 admin」的全部保证：没有改角色的入口，admin 只有创建者一个，能被移除的只有别人。
   * 正在协同编辑的那个人要当场断掉（`revoke` 在 204 之前 await）：WebSocket 是长连接，他在那段时间里改的东西会被 CRDT 合并、落库，其他人撤销不回来。
   */
  @Delete(':projectId/members/:userId')
  @HttpCode(204)
  @TeamProjectAdmin()
  async removeMember(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Param('userId') target: string): Promise<void> {
    if (user.id === target) throw badRequest('不能移除自己；如需退出请让其他管理员操作')
    if (!(await this.projects.removeMember(access.projectId, target))) {
      throw new HttpException({ error: 'Not Found', message: '成员不存在' }, 404)
    }
    await this.revocation.revoke()
  }

  /** 读接口也会写：没有链接就当场建一条，前端打开面板即拿到可复制的 URL */
  @Get(':projectId/invite')
  @TeamProjectAdmin()
  async invite(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Req() request: OriginRequest) {
    return this.withUrl(request, await this.projects.ensureInvite({ projectId: access.projectId, createdById: user.id }))
  }

  /** 改有效期：token 不变，已经发出去的链接继续可用 */
  @Patch(':projectId/invite')
  @TeamProjectAdmin()
  async setInviteExpiry(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Req() request: OriginRequest, @Body() raw: unknown) {
    const expiresInDays = parseExpiry(jsonBody<InvitePayload>(raw).expiresInDays)
    return this.withUrl(request, await this.projects.setInviteExpiry({ projectId: access.projectId, createdById: user.id, expiresInDays }))
  }

  /** 重置：换一个 token，旧链接立刻失效。请求体可以不带 */
  @Post(':projectId/invite/reset')
  @HttpCode(200)
  @TeamProjectAdmin()
  async resetInvite(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Req() request: OriginRequest, @Body() raw: unknown) {
    const body = (raw || {}) as InvitePayload
    const expiresInDays = parseExpiry(body.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS)
    return this.withUrl(request, await this.projects.resetInvite({ projectId: access.projectId, createdById: user.id, expiresInDays }))
  }

  @Get(':projectId/flows')
  @UseGuards(ProjectMemberGuard)
  async listFlows(@CurrentAccess() access: CanvasAccess, @Query() query: Record<string, unknown>) {
    const paged = unwrap(parsePagination(query))
    const sort = parseSort(queryText(query.sort))
    const status = queryText(query.status)
    if (status && !FLOW_STATUSES.includes(status as FlowStatus)) throw badRequest(`status 只能是 ${FLOW_STATUSES.join(' / ')}`)

    const { items, total } = await this.flows.listByProject(access.projectId, {
      ...paged,
      ...sort,
      keyword: queryText(query.keyword)?.trim() || undefined,
      status: (status || undefined) as FlowStatus | undefined,
    })
    return { items, ...paged, total, totalPages: Math.ceil(total / paged.pageSize) }
  }

  @Post(':projectId/flows')
  @UseGuards(ProjectMemberGuard)
  async createFlow(@CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess, @Body() raw: unknown) {
    const body = jsonBody<ProjectPayload>(raw)
    const name = unwrap(parseName(body.name))
    const description = unwrap(parseDescription(body.description ?? null))

    // 画布数上限**只对团队项目**生效（docs/16 §4.5）
    if (access.kind !== 'personal' && (await this.flows.countByProject(access.projectId)) >= PROJECT_LIMITS.flows) {
      throw badRequest(`项目内画布数已达上限 ${PROJECT_LIMITS.flows}`)
    }
    return this.flows.create({ projectId: access.projectId, name, description, createdById: user.id })
  }
}
