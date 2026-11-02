import type { InviteInvalidReason } from '@learning/contracts/canvas'
import { CurrentUser, type SessionUser } from '@learning/session'
import { Controller, Get, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { ProjectsService } from './projects.service.js'

/** 失效原因给各自的文案，不要一律「链接无效」。链接被重置后旧 token 查不到，走 not_found */
const REASON_TEXT: Record<InviteInvalidReason, string> = {
  not_found: '分享链接无效或已被重置',
  expired: '分享链接已过期',
  project_deleted: '项目已被删除',
  project_full: '项目成员数已达上限',
}

/**
 * 分享链接是加入项目的唯一入口。这两个端点按 token 判断而非成员身份 —— 访问者此刻当然还不是成员，但必须已登录。
 */
@Controller('api/invites')
export class InvitesController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get(':token')
  async preview(@CurrentUser() user: SessionUser, @Param('token') token: string) {
    const preview = await this.projects.previewInvite(token, user.id)
    return { ...preview, message: preview.reason ? REASON_TEXT[preview.reason] : undefined }
  }

  @Post(':token/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: SessionUser, @Param('token') token: string) {
    const result = await this.projects.acceptInvite(token, user.id)
    if (!result.ok) {
      throw new HttpException({ error: REASON_TEXT[result.reason], reason: result.reason }, result.reason === 'not_found' ? 404 : 400)
    }
    return { projectId: result.projectId }
  }
}
