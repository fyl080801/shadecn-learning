/**
 * @learning/collab —— Nest 服务的实时协同（docs/04、docs/30）：
 * - {@link CollabModule}：Hocuspocus 实例和它的业务钩子，没有 HTTP 入口；
 * - {@link CollabGatewayModule}：WebSocket upgrade、`/api/collab/*`、`/api/flows/:flowId/doc`。
 *
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/*`、`@nestjs/*`、`yjs` 都是 peerDependency，进程里的注入 token 和 `Y.Map` 只有应用装的那一份。
 */
export { CollabGatewayModule } from './collab-gateway.module.js'
export { type CollabContext, CollabServer } from './collab-server.js'
export { CollabModule } from './collab.module.js'
export { flowIdOf, FlowPersistence, roomOf, type StoreOptions, type StoreStats } from './flow-persistence.js'
export { COLLAB_LIMITS } from './quota.js'
