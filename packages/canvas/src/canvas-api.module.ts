import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { CanvasBodyErrorFilter } from './body-error.filter.js'
import { CanvasModule } from './canvas.module.js'
import { FlowsController } from './flows.controller.js'
import { InvitesController } from './invites.controller.js'
import { ProjectsController } from './projects.controller.js'

/** 画布 REST：`/api/projects`、`/api/invites`、`/api/flows`。登录靠根模块的 `APP_GUARD = ApiSessionGuard`，少了它路由是 500（`@CurrentUser()` 拿不到用户），不会变成匿名可访问 */
@Module({
  imports: [CanvasModule],
  controllers: [ProjectsController, InvitesController, FlowsController],
  providers: [{ provide: APP_FILTER, useClass: CanvasBodyErrorFilter }],
})
export class CanvasApiModule {}
