import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { Global, Module } from '@nestjs/common'
import { OIDC_OPTIONS, resolveOidcOptions } from './auth-options.js'
import { Session } from './entities.js'
import { resolveSessionOptions, SESSION_OPTIONS } from './options.js'
import { RequestOrigins } from './request-origins.js'
import { SessionPageAuth } from './session-page-auth.js'
import { SessionGuard } from './session.guard.js'
import { SessionService } from './session.service.js'
import { TokenRefresher } from './token-refresher.js'
import { UserService } from './user.service.js'

/**
 * 「这个请求是谁」：用户、会话的读取和续期、守卫。不暴露 `/api/auth/*`、不跑定时清理，要这些的进程再引入 {@link LoginModule}，协同这类服务只引入这一个。
 * 全局模块：在根模块 import 一次，别的模块不用 import 就能注入 service、用 `@UseGuards(SessionGuard)`、`APP_GUARD` 用 `ApiSessionGuard`。
 *
 * 配置是 config.yaml 的 `session` 段和 `auth.oidc`（续期要换 token），校验和默认值在 options.ts、auth-options.ts。
 * **多进程连同一个库时**，每个进程都要有同样的 `auth.oidc`（没配的进程续不了 OIDC 会话，那些请求按未登录处理），并且用 `cluster.mode: redis`（续期经共享锁互斥）。
 *
 * 依赖三个全局模块：`ConfigService`（`@learning/config`）、`DataAccess`（`@learning/data-access`）和 `Cluster`（`@learning/cluster`）。根模块没有 import 它们时，
 * Nest 启动就报依赖解析错误，而 `DataAccess` 背后的 ORM 工厂先同步表结构，所以和模块在 imports 里的先后无关（测试钉着）。
 */
@Global()
@Module({
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [Session] },
    { provide: SESSION_OPTIONS, inject: [ConfigService], useFactory: resolveSessionOptions },
    { provide: OIDC_OPTIONS, inject: [ConfigService], useFactory: resolveOidcOptions },
    RequestOrigins,
    TokenRefresher,
    UserService,
    SessionService,
    SessionGuard,
    SessionPageAuth,
  ],
  exports: [SESSION_OPTIONS, OIDC_OPTIONS, RequestOrigins, TokenRefresher, UserService, SessionService, SessionGuard, SessionPageAuth],
})
export class SessionIdentityModule {}
