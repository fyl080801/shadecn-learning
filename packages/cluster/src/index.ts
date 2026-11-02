/**
 * @learning/cluster —— 跨进程共享状态：`single` 模式是进程内实现，`redis` 模式走 Redis，调用方不用分支。
 * 本期只有 {@link SharedLock}，其余结构（语义见 `packages/server-kit/src/cluster/shared.ts`）等协同迁过来时再加。
 * 只依赖 `@learning/config`，不认识任何业务模块。
 */
export type { ClusterBackend } from './backend.js'
export { Cluster } from './cluster.js'
export { ClusterModule } from './module.js'
export { assertClusterDatabase } from './options.js'
export { SharedLock, SharedLockUnavailableError } from './shared-lock.js'
