import { type CanvasAccess, CurrentAccess, FlowMemberGuard } from '@learning/canvas'
import { FLOW_STATE_VECTOR_HEADER } from '@learning/contracts/collab'
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common'
import { decodeStateVectorParam, FlowWriter } from './flow-writer.js'

const notFound = () => new HttpException({ error: 'Not Found', message: '画布不存在' }, 404)

/**
 * 个人画布的内容通道（docs/16）：拉一次基线、推一段增量。
 * 项目画布**不许走这条路**（409）：绕过去就绕过了单连接互斥和内存里的活房间，写进库的东西还会被房间下一次落库合并进去，客户端却以为自己存上了。
 */
@Controller('api/flows/:flowId/doc')
@UseGuards(FlowMemberGuard)
export class FlowDocController {
  constructor(@Inject(FlowWriter) private readonly writer: FlowWriter) {}

  private rejectCollabFlow(access: CanvasAccess): void {
    if (access.kind !== 'personal') throw new HttpException({ error: 'Conflict', message: '项目画布的内容走协同连接，不走这个接口' }, 409)
  }

  /** 二进制不经 JSON。状态向量走响应头：它是服务端自己的进度，客户端拿它当下次算差量的基线 */
  @Get()
  async pull(
    @Param('flowId') flowId: string,
    @Query('sv') sv: unknown,
    @CurrentAccess() access: CanvasAccess,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<Buffer> {
    this.rejectCollabFlow(access)

    let since: Uint8Array | undefined
    if (typeof sv === 'string' && sv) {
      const decoded = decodeStateVectorParam(sv)
      if (!decoded) throw new HttpException({ error: 'sv 不是合法的状态向量' }, 400)
      since = decoded
    }

    const state = await this.writer.read(flowId, since)
    if (!state) throw notFound()

    reply.header('content-type', 'application/octet-stream')
    reply.header('cache-control', 'no-store')
    reply.header(FLOW_STATE_VECTOR_HEADER, Buffer.from(state.stateVector).toString('base64url'))
    return Buffer.from(state.update)
  }

  @Post()
  @HttpCode(200)
  async push(@Param('flowId') flowId: string, @Body() body: unknown, @CurrentAccess() access: CanvasAccess) {
    this.rejectCollabFlow(access)

    // 没带 content-type、或带了别的类型的请求体都不是二进制，和空请求体一样不是一段增量
    if (!Buffer.isBuffer(body) || body.byteLength === 0) throw new HttpException({ error: '请求体不能为空' }, 400)

    const result = await this.writer.apply(flowId, new Uint8Array(body))
    if (!result.ok) {
      if (result.reason === 'not-found') throw notFound()
      throw new HttpException({ error: result.message }, 413)
    }
    return { stateVector: Buffer.from(result.stateVector).toString('base64url'), revision: result.revision, noop: result.noop }
  }
}
