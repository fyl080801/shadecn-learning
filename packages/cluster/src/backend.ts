import type { SharedLock } from './shared-lock.js'

/** 共享结构的一种实现。现在只有锁，其余的结构等协同迁过来时再加 */
export interface ClusterBackend {
  createLock(namespace: string): SharedLock
  close(): Promise<void>
}
