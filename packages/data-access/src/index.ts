/**
 * @learning/data-access —— Nest 服务的数据访问模块：启动时把库对齐到实体定义，经依赖注入提供 {@link DataAccess}。
 * 实体定义、同步守卫都复用现有代码（`@shadecn/server-kit`、`@shadecn/mod-*` 的 entities），这里只负责接进 Nest 的生命周期。
 *
 * **单例不变式**：产物由 esbuild 把 `@shadecn/*` 内联进 dist（scripts/build.mjs），实体对象只有 dist 里这一份。
 * 消费者必须从本包拿实体，**不能再 import `@shadecn/*`** —— 否则进程里有两份实体定义，MikroORM 的元数据对不上第二份
 * （报 `Cannot set properties of undefined (setting '__schema')` 这类不知所云的错）。类型同理：只从本包 import。
 * 编译型的兄弟包（`@learning/session`）也一样，它们要用的实体、纯函数、异常类都从这里 re-export。
 *
 * `@learning/config` 反过来，**必须留 external**：`ConfigService` 是注入 token，内联就成了第二份类，DI 找不到（`test/dist.test.ts` 钉着）。
 */
export { DataAccess } from './data-access.js'
export { dataAccessEntities } from './entities.js'
export { DataAccessModule } from './module.js'

export { UniqueConstraintViolationException, type EntityManager, type MikroORM } from '@mikro-orm/core'
export { newSessionToken, sessionTokenId, toSessionUser, type SessionUser } from '@shadecn/server-kit/session'
export { SchemaDataLossError, type DataLossKind, type DataLossStatement } from '@shadecn/server-kit/schema-sync'
export {
  OidcError,
  GITHUB_DEFAULT_SCOPE,
  createGithubClient,
  createOidcClient,
  normalizeOrigin,
  pickOrigin,
  randomToken,
  type GithubClient,
  type OidcClient,
  type ProviderProfile,
  type ProviderTokens,
} from '@shadecn/server-kit/oauth'
export { resolveLoginIdentity } from '@shadecn/mod-auth/login-identity'
export { LOGIN_DONE_PATH, renderLoginDonePage } from '@shadecn/mod-auth/login-done-page'

export { User } from '@shadecn/server-kit/identity'
export { AuthRequest, PendingLink, Session, UserIdentity } from '@shadecn/mod-auth/entities'
export { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from '@shadecn/mod-canvas/entities'
export { FlowAsset } from '@shadecn/mod-storage/entities'
export { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from '@shadecn/mod-agent/entities'
export { AppTask } from '@shadecn/mod-apps/entities'
