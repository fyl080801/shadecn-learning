import { Controller, Delete, Get, Header, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { CurrentUser } from './current-user.decorator.js'
import { IdentitiesService, linkFailureMessage } from './identities.service.js'
import type { SessionUser } from './session-token.js'

/**
 * 设置页「登录方式」读写的接口，形状以 `apps/web/src/lib/api.ts` 的 `authApi` 为准。发起关联要跳转，和回调一起在 `AuthController`。
 * 没有 `@Public()`：登录靠根模块的 `APP_GUARD = ApiSessionGuard`，少了它路由是 500（`@CurrentUser()` 拿不到用户），不会变成匿名可访问。
 */
@Controller('api/auth')
export class IdentitiesController {
  constructor(@Inject(IdentitiesService) private readonly identities: IdentitiesService) {}

  /** 绑了哪些登录方式，外加**有没有一条在等确认**：挂在响应里而不是 URL 上，用户中途关了标签页再回来，确认框照样出现 */
  @Get('identities')
  @Header('cache-control', 'no-store')
  async list(@CurrentUser() user: SessionUser) {
    const [items, pending] = await Promise.all([this.identities.listFor(user.id), this.identities.pendingFor(user.id)])
    return { items, pending }
  }

  /** 确认关联，到这一步才写绑定。POST：状态变更，必须不能由一条链接触发 */
  @Post('link/confirm')
  @HttpCode(200)
  async confirm(@CurrentUser() user: SessionUser) {
    const result = await this.identities.confirmPending(user.id)
    if (result.ok) {
      console.log(`[session] 用户 ${user.id} 确认关联 ${result.identity.provider}`)
      return { identity: result.identity }
    }
    if (result.reason === 'none') throw new HttpException({ error: 'Not Found', message: '没有待确认的关联' }, 404)
    if (result.reason === 'expired') throw new HttpException({ error: 'Gone', message: '确认超时了，请重新发起关联' }, 410)
    // 预检到确认之间局面变了（那条身份被别人绑走之类）
    throw new HttpException({ error: 'Conflict', message: linkFailureMessage(result.reason, result.label ?? '第三方') }, 409)
  }

  /** 放弃这条待确认的关联 */
  @Delete('link/pending')
  @HttpCode(204)
  async discard(@CurrentUser() user: SessionUser) {
    await this.identities.discardPending(user.id)
  }

  /** 解绑。前端也会把按钮禁掉，但判定必须在服务端 */
  @Delete('identities/:id')
  @HttpCode(204)
  async unlink(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    const result = await this.identities.unlink(user.id, id)
    if (result === 'not-found') throw new HttpException({ error: 'Not Found', message: '没有这条登录方式' }, 404)
    if (result === 'last') throw new HttpException({ error: 'Conflict', message: '至少要保留一种登录方式' }, 409)
  }
}
