import { ConfigService } from '@learning/config'
import { Global, Module } from '@nestjs/common'
import { AuthController } from './auth.controller.js'
import { AuthProviders } from './auth-providers.js'
import { LoginService } from './login.service.js'
import { resolveSessionOptions, SESSION_OPTIONS } from './options.js'
import { SessionPageAuth } from './session-page-auth.js'
import { SessionGuard } from './session.guard.js'
import { SessionService } from './session.service.js'
import { UserService } from './user.service.js'

/**
 * 用户、会话和登录：在根模块 import 一次，别的模块不用 import 就能注入 service、用 `@UseGuards(SessionGuard)`。
 * 配置是 config.yaml 的 `session`、`auth` 段和 `server.origins`，校验和默认值在 options.ts、auth-options.ts。
 *
 * 依赖两个全局模块：`ConfigService`（`@learning/config`）和 `DataAccess`（`@learning/data-access`）。根模块没有 import 它们时，
 * Nest 启动就报依赖解析错误，而 `DataAccess` 背后的 ORM 工厂先同步表结构，所以和模块在 imports 里的先后无关（测试钉着）。
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    { provide: SESSION_OPTIONS, inject: [ConfigService], useFactory: resolveSessionOptions },
    AuthProviders,
    UserService,
    SessionService,
    LoginService,
    SessionGuard,
    SessionPageAuth,
  ],
  exports: [SESSION_OPTIONS, UserService, SessionService, SessionGuard, SessionPageAuth],
})
export class SessionModule {}
