import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { Module } from '@nestjs/common'
import { LOGIN_OPTIONS, OIDC_OPTIONS, resolveLoginOptions } from './auth-options.js'
import { AuthController } from './auth.controller.js'
import { AuthProviders } from './auth-providers.js'
import { AuthRequest, PendingLink, UserIdentity } from './entities.js'
import { LoginService } from './login.service.js'
import { SessionIdentityModule } from './identity.module.js'
import { SessionSweeper } from './session-sweeper.js'

/**
 * 登录：`/api/auth/*`、OIDC / GitHub 的登录流程、定时清理。配置是 config.yaml 的 `auth` 段、`server.origins` 和 `session.loginPath`。
 * 依赖 {@link SessionIdentityModule}（它是全局的，这里显式 import 是为了单独引入这个模块也能启动）。
 *
 * `PendingLink` 只有定义，账号关联还没有实现；登记在这里是因为它和 `AuthRequest.linkUserId` 同属登录流程，表结构和现有的库一致。
 */
@Module({
  imports: [SessionIdentityModule],
  controllers: [AuthController],
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [UserIdentity, PendingLink, AuthRequest] },
    { provide: LOGIN_OPTIONS, inject: [ConfigService, OIDC_OPTIONS], useFactory: resolveLoginOptions },
    AuthProviders,
    LoginService,
    SessionSweeper,
  ],
})
export class LoginModule {}
