import type { FlowDetail, FlowStatus, FlowSummary } from '@learning/contracts/canvas'
import { CurrentUser, type SessionUser } from '@learning/session'
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { AccessRevocation } from './access-revocation.js'
import { FlowDocStore } from './flow-doc.store.js'
import { parseUserStatePatch } from './flow-types.js'
import { FLOW_STATUSES, FlowsService } from './flows.service.js'
import { FlowMemberGuard } from './guards.js'
import { badRequest, jsonBody, parseDescription, parseName, unwrap } from './params.js'

interface FlowPatchPayload {
  name?: unknown
  description?: unknown
  status?: unknown
  tags?: unknown
}

const flowNotFound = () => new HttpException({ error: 'Not Found', message: '画布不存在' }, 404)

/**
 * `/api/flows`：画布元数据。画布的访问权来自项目成员身份，非成员一律 404。
 * 内容没有 REST 写入口：`/doc` 属于协同模块，和别的模块挂在这个前缀下的路由一样自己叠 {@link FlowMemberGuard}。
 */
@Controller('api/flows')
@UseGuards(FlowMemberGuard)
export class FlowsController {
  constructor(
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(FlowDocStore) private readonly docs: FlowDocStore,
    @Inject(AccessRevocation) private readonly revocation: AccessRevocation,
  ) {}

  /** userState（视口等）是**这个人**的，所以详情要带上请求者身份 */
  @Get(':flowId')
  async get(@CurrentUser() user: SessionUser, @Param('flowId') flowId: string): Promise<FlowDetail> {
    const flow = await this.flows.get(flowId, user.id)
    if (!flow) throw flowNotFound()
    return flow
  }

  @Patch(':flowId')
  update(@Param('flowId') flowId: string, @Body() raw: unknown): Promise<FlowSummary> {
    const body = jsonBody<FlowPatchPayload>(raw)
    const patch: { name?: string; description?: string | null; status?: FlowStatus; tags?: string[] } = {}
    if (body.name !== undefined) patch.name = unwrap(parseName(body.name))
    if (body.description !== undefined) patch.description = unwrap(parseDescription(body.description))
    if (body.status !== undefined) {
      if (!FLOW_STATUSES.includes(body.status as FlowStatus)) throw badRequest(`status 只能是 ${FLOW_STATUSES.join(' / ')}`)
      patch.status = body.status as FlowStatus
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) throw badRequest('tags 必须是字符串数组')
      patch.tags = body.tags as string[]
    }
    return this.flows.update(flowId, patch)
  }

  /** 画布已删 = 这个房间谁都进不去了。还开着那张画布的人当场断掉，不然他会继续对着一张已经不存在的画布画 */
  @Delete(':flowId')
  @HttpCode(204)
  async remove(@Param('flowId') flowId: string): Promise<void> {
    await this.flows.softDelete(flowId)
    await this.revocation.revoke()
  }

  /** 按用户存的画布状态（视口…）。PATCH 语义：只带要改的分区。这些状态不是画布内容：不进快照、不涨 revision，只平移一下画布同样要能存下来 */
  @Patch(':flowId/user-state')
  @HttpCode(204)
  async patchUserState(@CurrentUser() user: SessionUser, @Param('flowId') flowId: string, @Body() raw: unknown): Promise<void> {
    await this.flows.patchUserState(flowId, user.id, unwrap(parseUserStatePatch(jsonBody<unknown>(raw))))
  }

  /**
   * 复制画布。复制的是库里那份 ydoc，所以要先把**还开着的房间**落库。
   * 房间可能开在任何一个协同实例上：经总线问全部，超时 / 没有协同实例就按库里现有内容复制（`flush` 从不抛错）。
   */
  @Post(':flowId/duplicate')
  async duplicate(@CurrentUser() user: SessionUser, @Param('flowId') flowId: string): Promise<FlowDetail> {
    await this.docs.flush(flowId)
    const copy = await this.flows.duplicate(flowId, user.id)
    if (!copy) throw flowNotFound()
    return copy
  }
}
