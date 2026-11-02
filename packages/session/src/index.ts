/**
 * @learning/session —— Nest 服务的用户、会话和登录：OIDC / GitHub 登录流程（`/api/auth/*`），用户查询 / 建号，会话的建 / 读 / 续期 / 删 / 定时清理，守卫，当前用户装饰器。
 * 协议代码和身份判定不在这里写第二份，都是 `@shadecn/server-kit/oauth`、`@shadecn/mod-auth/login-identity` 的那一份（经 data-access 转出）。
 * 账号关联（link、identities、PendingLink）还只在 `@shadecn/mod-auth`。
 *
 * **只依赖 `@learning/data-access` 和 `@learning/config`，不 import `@shadecn/*`**：data-access 的产物内联了 `@shadecn/*`，实体对象只有它那一份，
 * 这里再 import 就是第二份，MikroORM 的元数据对不上。实体和纯函数都从 data-access 拿，`test/package.test.ts` 钉着。
 * 这两个都是 peerDependency，进程里的 `DataAccess`、`ConfigService` 也只有应用装的那一份。
 */
export { ApiSessionGuard } from './api-session.guard.js'
export { CurrentUser } from './current-user.decorator.js'
export { Public } from './public.decorator.js'
export { SessionPageAuth } from './session-page-auth.js'
export { SessionModule } from './module.js'
export { SessionGuard } from './session.guard.js'
export { type CreateSessionInput, type LoadedSession, SessionService, type SessionTokens } from './session.service.js'
export { type FindOrCreateUserInput, UserService } from './user.service.js'
export type { SessionUser } from '@learning/data-access'
