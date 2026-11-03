import { validatePrompt, type AgentRuntime } from '@learning/agent-core/session'
import { type CanvasAccess, CurrentAccess, FlowMemberGuard } from '@learning/canvas'
import type { AgentAttachment, AgentAttachmentRef } from '@learning/contracts/agent'
import { CurrentUser, type SessionUser } from '@learning/session'
import { AssetStorage } from '@learning/storage'
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Post, Res, UseGuards } from '@nestjs/common'
import { AgentCanvasAccess } from './canvas-access.js'
import { AGENT_RUNTIME } from './sandbox.js'
import { AgentSseStreams, type SseReply, SseRelay } from './sse.js'

const INVALID_JSON = '请求体不是合法 JSON'

const fail = (status: number, error: string, message: string) => new HttpException({ error, message }, status)
const conversationNotFound = () => fail(404, 'Not Found', '会话不存在')
const unavailable = (message: string) => fail(503, 'Service Unavailable', message)
/** 退出已经开始：协同正在关房间，这时开一轮要么写不进去，要么挡住退出 */
const restarting = () => unavailable('服务正在重启，请稍后再试')

/**
 * 画布 Agent 的接口（REQ-AGENT，契约在 `@learning/contracts/agent`）。路由、状态码、响应形状和 `mod-agent/src/routes.ts` 一样，前端不用改。
 *
 * 全局的 `ApiSessionGuard` 管登录（401），`FlowMemberGuard` 每次请求重查成员：非成员、画布不存在一律 404。个人画布也走这里。
 *
 * | 接口 | 发起人 | 其他成员 | 项目管理员 | 非成员 |
 * |---|---|---|---|---|
 * | `GET /`、`GET /conversations`、`GET /conversations/:id` | ✓ | ✓（只读） | ✓（只读） | 404 |
 * | `GET /runs/:runId/events`（接回 / 旁观） | ✓ | ✓（只读） | ✓（只读） | 404 |
 * | `POST /messages` 续聊某个会话 | ✓ | 403 | 403 | 404 |
 * | `DELETE /conversations/:id` | ✓ | 403 | 403 | 404 |
 * | `POST /runs/:runId/abort` | ✓ | 403 | ✓ | 404 |
 *
 * 不存在的会话、不在这张画布上的会话一律 404（先于 403 判）；新会话谁都能发起。
 *
 * **会话只管发起**：这里判「谁发起、能不能发起」，之后这一轮凭 Grant，发起人退出登录、会话过期都不会让它停下（docs/22 §6）。
 *
 * 两个 SSE 路由的状态码都必须在开流之前定：`AgentSseStreams.open` 一 hijack 就是 200。
 */
@Controller('api/flows/:flowId/agent')
@UseGuards(FlowMemberGuard)
export class AgentController {
  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(AgentCanvasAccess) private readonly canvas: AgentCanvasAccess,
    @Inject(AssetStorage) private readonly storage: AssetStorage,
    @Inject(AgentSseStreams) private readonly streams: AgentSseStreams,
  ) {}

  /** 面板打开（以及协同连接连上 / 重连）时的那一次：是否启用、这张画布此刻在跑的全部任务、默认打开的会话 */
  @Get()
  view(@Param('flowId') flowId: string, @CurrentUser() user: SessionUser) {
    return this.runtime.view(flowId, user.id)
  }

  /** 这张画布上所有人的会话列表，按 updatedAt 倒序（不含消息） */
  @Get('conversations')
  listConversations(@Param('flowId') flowId: string, @CurrentUser() user: SessionUser) {
    return this.runtime.listConversations(flowId, user.id)
  }

  /** 一个会话的全部内容。能进这张画布的人都能读（别人的只读） */
  @Get('conversations/:conversationId')
  async getConversation(@Param('flowId') flowId: string, @Param('conversationId') conversationId: string, @CurrentUser() user: SessionUser) {
    const view = await this.runtime.getConversation(flowId, user.id, conversationId)
    if (!view) throw conversationNotFound()
    return view
  }

  /** 只有发起人能删（别人 403）；它正在跑一轮时 409 */
  @Delete('conversations/:conversationId')
  @HttpCode(204)
  async deleteConversation(@Param('flowId') flowId: string, @Param('conversationId') conversationId: string, @CurrentUser() user: SessionUser): Promise<void> {
    const result = await this.runtime.deleteConversation(flowId, user.id, conversationId)
    if (result === 'running') throw fail(409, 'Conflict', '这个会话还有一轮在运行，先中止或等它结束再删除')
    if (result === 'not-found') throw conversationNotFound()
    if (result === 'forbidden') throw fail(403, 'Forbidden', '这是别人的会话，只有发起人可以删除它')
  }

  /**
   * 发一条消息、跑一轮，以 `text/event-stream` 回复（AG-UI 的 HTTP 编码：每帧只有 `data: <事件 JSON>\n\n`，没有 `event:` 行）。
   *
   * `conversationId` 为空 = 新会话：id 经 RUN_STARTED 的 `threadId` 带回。新会话可以带 `nodeId` = 入口节点（只记录、不限制工具）。附件的归属在 {@link resolveAttachments} 查。
   *
   * 流开到这一轮彻底结束（运行日志写完）才关：收到最后一帧时，`GET` 读到的已经是落定的状态。
   */
  @Post('messages')
  async send(@Param('flowId') flowId: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Res() reply: SseReply): Promise<void> {
    const { runtime, canvas } = this
    if (!runtime.enabled) throw unavailable(`画布 Agent 未启用：${runtime.disabledReason}`)
    if (!body) throw new HttpException({ error: INVALID_JSON }, 400)
    const prompt = validatePrompt(body)
    if (!prompt.ok) throw new HttpException({ error: prompt.error }, 400)

    // 查过之后、这一轮开始之前它才被删掉的（极窄的窗口）由编排层以 RUN_ERROR 收尾；编排层读会话时 where 里同样带着 user，这里漏判也续不了别人的会话
    if (prompt.conversationId !== null) {
      const existing = await runtime.getConversation(flowId, user.id, prompt.conversationId)
      if (!existing) throw conversationNotFound()
      if (!existing.mine) throw fail(403, 'Forbidden', '这是别人的会话，只能查看，不能继续对话')
    }
    if (prompt.nodeId !== null && !(await canvas.flowHasNode(flowId, prompt.nodeId))) throw fail(404, 'Not Found', '这张画布上没有这个节点')
    const attachments = await this.resolveAttachments(flowId, prompt.attachments)

    const relay = new SseRelay()
    const starting = this.streams.admit(() =>
      runtime.start({
        flowId,
        userId: user.id,
        text: prompt.text,
        conversationId: prompt.conversationId,
        nodeId: prompt.nodeId,
        attachments,
        openCanvas: (runId, authority) => canvas.open({ flowId, userId: user.id, runId, authority }),
        emit: relay.emit,
      }),
    )
    if (!starting) throw restarting()
    const started = await starting
    if (!started.ok) throw started.reason === 'busy' ? fail(409, 'Conflict', started.message) : unavailable(started.message)
    this.streams.open(reply, relay, started.done, started.unsubscribe)
  }

  /**
   * 接回 / 旁观正在跑的一轮：先从头补发它已经发出的全部事件，再接着推后续的，序列和发起时那条流逐帧相同。
   * 不是这张画布此刻在跑的一轮 → 404；补发缓冲已经溢出 → 410。
   */
  @Get('runs/:runId/events')
  async events(@Param('flowId') flowId: string, @Param('runId') runId: string, @Res() reply: SseReply): Promise<void> {
    if (this.streams.draining) throw restarting()
    const relay = new SseRelay()
    const subscribed = await this.runtime.subscribe(flowId, runId, relay.emit)
    if (!subscribed.ok) {
      if (subscribed.reason === 'overflowed') throw fail(410, 'Gone', '这一轮的事件太多，接不回完整的进度；等它结束后重新打开会话')
      throw fail(404, 'Not Found', '这一轮已经结束或不存在')
    }
    this.streams.open(reply, relay, subscribed.done, subscribed.unsubscribe)
  }

  /** 中止某一轮：发起人或项目管理员；已经结束、runId 不对都当已经停了（幂等，204）。角色取自守卫这次请求刚查的，不缓存 */
  @Post('runs/:runId/abort')
  @HttpCode(204)
  async abort(@Param('flowId') flowId: string, @Param('runId') runId: string, @CurrentUser() user: SessionUser, @CurrentAccess() access: CanvasAccess): Promise<void> {
    const result = await this.runtime.abort(flowId, runId, { userId: user.id, admin: access.role === 'admin' })
    if (result === 'forbidden') throw fail(403, 'Forbidden', '只有发起这一轮的人或项目管理员可以中止它')
  }

  /**
   * 附件（docs/20 §3.10.12）：每个键都必须是**这张画布**上传时记下的，别的画布的、猜的、没上传成功的一律不认（整条消息 400，不挑着收）。
   * 类型取上传记录里服务端看到的，地址按键现算；客户端给的只有键和显示名。
   */
  private async resolveAttachments(flowId: string, refs: readonly AgentAttachmentRef[]): Promise<AgentAttachment[]> {
    if (refs.length === 0) return []
    if (!this.storage.available) throw unavailable('未配置对象存储，不能带附件')
    const records = await this.storage.findInFlow(flowId, refs.map((ref) => ref.key))
    if (records.length !== refs.length) throw fail(400, 'Bad Request', '附件必须是在这张画布上传的资源')
    return refs.map((ref, index) => ({ key: ref.key, url: this.storage.objectUrl(ref.key) as string, contentType: records[index]!.contentType, name: ref.name }))
  }
}
