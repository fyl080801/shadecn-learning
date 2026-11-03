import { type CanvasAccess, CurrentAccess, FlowMemberGuard } from '@learning/canvas'
import { Cluster } from '@learning/cluster'
import { CurrentUser, type SessionUser } from '@learning/session'
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, UseGuards } from '@nestjs/common'
import { httpErrorOf, paramsFromBody } from './apps.controller.js'
import { AppsService } from './apps.service.js'
import { AppError } from './contract.js'
import { APPS_CANCEL_TASK } from './task-bus.js'
import { TaskRunner } from './task-runner.js'
import { AppTasks } from './tasks.js'

/** 节点 id 的格式上限（同 `createId`） */
const NODE_ID_MAX = 64
const CANCEL_NOTIFY_TIMEOUT_MS = 3_000

/**
 * `/api/flows/:flowId/apps`（docs/29 §3.8、§3.10）：画布节点的生成任务，叠 {@link FlowMemberGuard}（非成员 404）。
 *
 * - `POST /:appId/execute` `{ params, nodeId }` —— 当场校验参数（错了 400，不建任务）、同一节点已有进行中的任务 409，建任务行后交给 {@link TaskRunner}，回 `202 { task }`；
 * - `GET /tasks` —— 这张画布进行中的任务 `{ tasks, now }`（之后的变化走房间的 `apps:tasks` 推送）；
 * - `POST /tasks/:taskId/cancel` —— 发起人或项目管理员；已结束 / 不存在 204（幂等）。
 *
 * 路由不碰画布内容：参考图换字节、产物存资源、写回节点都在 {@link TaskRunner}。
 */
@Controller('api/flows/:flowId/apps')
@UseGuards(FlowMemberGuard)
export class FlowAppsController {
  constructor(
    @Inject(AppsService) private readonly service: AppsService,
    @Inject(AppTasks) private readonly tasks: AppTasks,
    @Inject(TaskRunner) private readonly runner: TaskRunner,
    @Inject(Cluster) private readonly cluster: Cluster,
  ) {}

  @Get('tasks')
  async list(@Param('flowId') flowId: string) {
    const tasks = await this.runner.viewsOf(await this.tasks.listActive(flowId))
    return { tasks, now: Date.now() }
  }

  @Post('tasks/:taskId/cancel')
  @HttpCode(204)
  async cancel(@Param('flowId') flowId: string, @Param('taskId') taskId: string, @CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess): Promise<void> {
    const row = await this.tasks.get(taskId)
    if (!row || row.flowId !== flowId) return
    if (row.userId !== user.id && access.role !== 'admin') throw new HttpException({ error: '只有发起人和项目管理员能取消这个任务' }, 403)
    if (!(await this.tasks.cancel(row.id))) return
    // 通知在跑它的进程立刻停（丢了也不要紧：它下一次续租会读到 canceled）
    await this.cluster.bus.request(APPS_CANCEL_TASK, { taskId: row.id }, { timeoutMs: CANCEL_NOTIFY_TIMEOUT_MS })
    // 排队中的没有执行方替它推送：这里推一次，别的协作者的列表才会去掉它（刚被接手的话会多推一次，无害）
    if (row.status === 'queued') await this.runner.pushTasks(flowId)
    console.info(`[apps] 任务 ${row.id} 已取消（${user.id}）`)
  }

  @Post(':appId/execute')
  @HttpCode(202)
  async execute(@Param('flowId') flowId: string, @Param('appId') appId: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const params = paramsFromBody(body)
    if (!params) throw new HttpException({ error: '请求体必须是 { params: {...}, nodeId }', code: 'invalid_params' }, 400)
    const nodeId = (body as { nodeId?: unknown }).nodeId
    if (typeof nodeId !== 'string' || !nodeId || nodeId.length > NODE_ID_MAX) {
      throw new HttpException({ error: '缺少 nodeId（结果写回哪个节点）', code: 'invalid_params' }, 400)
    }
    let model: string | undefined
    try {
      model = this.service.validate(appId, params).model
    } catch (err) {
      if (err instanceof AppError) throw httpErrorOf(err)
      throw err
    }
    const row = await this.tasks.create({ flowId, nodeId, userId: user.id, appId, model, params })
    if (!row) throw new HttpException({ error: '这个节点正在生成，等它完成或先取消', code: 'busy' }, 409)
    // 抢不到（正在退出）也没关系：任务行留在 queued，等对账接手
    await this.runner.runTask(row.id)
    const [task] = await this.runner.viewsOf([(await this.tasks.get(row.id)) ?? row])
    return { task }
  }
}
