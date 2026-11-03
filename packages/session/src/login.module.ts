import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { Module } from '@nestjs/common'
import { LOGIN_OPTIONS, OIDC_OPTIONS, resolveLoginOptions } from './auth-options.js'
import { AuthController } from './auth.controller.js'
import { AuthProviders } from './auth-providers.js'
import { AvatarsController } from './avatars.controller.js'
import { AuthRequest, PendingLink, UserIdentity } from './entities.js'
import { IdentitiesController } from './identities.controller.js'
import { IdentitiesService } from './identities.service.js'
import { LoginService } from './login.service.js'
import { SessionIdentityModule } from './identity.module.js'
import { SessionSweeper } from './session-sweeper.js'
import { UserProfileCompleter } from './user-profile.js'

/**
 * 登录：`/api/auth/*`（含账号关联）、`/api/avatars`、OIDC / GitHub 的登录流程、定时清理。配置是 config.yaml 的 `auth` 段、`server.origins` 和 `session.loginPath`。
 * 依赖 {@link SessionIdentityModule}（它是全局的，这里显式 import 是为了单独引入这个模块也能启动）。
 *
 * 要登录的路由靠根模块的 `APP_GUARD = ApiSessionGuard`。只引入身份模块的进程（协同副本）没有这些路由和这几张表，用户头像从 `User.avatarUrl` 读（`user-profile.ts`）。
 */
@Module({
  imports: [SessionIdentityModule],
  controllers: [AuthController, IdentitiesController, AvatarsController],
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [UserIdentity, PendingLink, AuthRequest] },
    { provide: LOGIN_OPTIONS, inject: [ConfigService, OIDC_OPTIONS], useFactory: resolveLoginOptions },
    AuthProviders,
    IdentitiesService,
    UserProfileCompleter,
    LoginService,
    SessionSweeper,
  ],
})
export class LoginModule {}
