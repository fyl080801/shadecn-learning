/**
 * @learning/session —— Nest 服务的用户、会话和登录：
 * - {@link SessionIdentityModule}：用户查询 / 建号，会话的建 / 读 / 续期 / 删，守卫，当前用户装饰器；
 * - {@link LoginModule}：OIDC / GitHub 登录流程（`/api/auth/*`），定时清理；
 * - {@link SessionModule}：上面两个的组合。
 * 账号关联（link、identities）还没有实现，`PendingLink` 只有定义。
 *
 * 表归这里（`entities.ts`），经 `DATA_ACCESS_ENTITIES` 登记给 `@learning/data-access`；`User` 是 data-access 的。
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/data-access`、`@learning/config`、`@learning/cluster`、`@learning/contracts`、`@mikro-orm/core` 是 peerDependency，
 * 进程里的 `DataAccess`、`ConfigService`、`Cluster`、实体基类都只有应用装的那一份。
 */
export { ApiSessionGuard } from './api-session.guard.js'
export { ClusterDatabaseCheckModule } from './cluster-database.module.js'
export { CurrentUser } from './current-user.decorator.js'
export { SessionIdentityModule } from './identity.module.js'
export { LoginModule } from './login.module.js'
export { SessionModule } from './module.js'
export { Public } from './public.decorator.js'
export type { SessionUser } from './session-token.js'
export { normalizeOrigin } from './oauth/index.js'
export { type OriginRequest, RequestOrigins } from './request-origins.js'
export { SessionPageAuth } from './session-page-auth.js'
export { readCookie, SessionGuard } from './session.guard.js'
export { type CreateSessionInput, type LoadedSession, type LoadSessionOptions, SessionService, type SessionTokens } from './session.service.js'
export { displayNameOf, type FindOrCreateUserInput, UserService } from './user.service.js'
