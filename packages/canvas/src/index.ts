/**
 * @learning/canvas —— 项目、成员、邀请、画布（docs/13、docs/16、docs/30 §2）：
 * - {@link CanvasModule}：服务层，协同这类不要 REST 的进程也 import；
 * - {@link CanvasApiModule}：画布 REST。
 *
 * 表归这里（`entities.ts`），经 `DATA_ACCESS_ENTITIES` 登记；和 `@shadecn/mod-canvas` 是两份定义，互不同步。
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/*`、`@nestjs/*`、`@mikro-orm/core` 都是 peerDependency，进程里的注入 token 和实体基类只有应用装的那一份。
 */
export { AccessRevocation, REVOCATION_POLL_INTERVAL_MS, type RevocationWatcher } from './access-revocation.js'
export { CanvasApiModule } from './canvas-api.module.js'
export { CanvasModule } from './canvas.module.js'
export { Flow, FlowUserState, Project, ProjectInvite, ProjectMember } from './entities.js'
export {
  CANVAS_FLUSH_CONTENT,
  type FlowDocReadOptions,
  type FlowDocRow,
  FlowDocStore,
  type FlowDocWrite,
  FLUSH_CONTENT_TIMEOUT_MS,
} from './flow-doc.store.js'
export { GRAPH_LIMITS, parseGraph, readGraph } from './flow-types.js'
export { FLOW_STATUSES, type FlowTarget, FlowsService, modeOfKind } from './flows.service.js'
export { type CanvasAccess, CurrentAccess, FlowMemberGuard } from './guards.js'
export { type Membership, PROJECT_LIMITS, ProjectsService } from './projects.service.js'
