/**
 * @learning/cluster —— 跨进程共享状态：`single` 模式是进程内实现，`redis` 模式走 Redis，调用方不用分支。
 * 提供 {@link SharedLock}、{@link SharedMap}、{@link SharedLog}、{@link SharedChannel}、{@link Bus}，语义照 `packages/server-kit/src/cluster/`，只有调用方用得到的方法。
 * 只依赖 `@learning/config`，不认识任何业务模块。
 */
export type { ClusterBackend, ClusterHealth } from './backend.js'
export { Bus, defineRequest, type RequestToken, type ScatterResult } from './bus.js'
export { Cluster } from './cluster.js'
export { createMemoryBackend } from './memory.js'
export { ClusterModule } from './module.js'
export { assertClusterDatabase } from './options.js'
export { SharedLock, SharedLockUnavailableError } from './shared-lock.js'
export { bytesCodec, type Codec, jsonCodec, type LogAppendOptions, type LogEntry, SharedChannel, SharedLog, SharedMap, stringCodec } from './shared-state.js'
