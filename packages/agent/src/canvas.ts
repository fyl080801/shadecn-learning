import * as Y from 'yjs'
import type { AgentTransactionOrigin } from '@shadecn/shared/agent'

/**
 * 画布工具够得着的那张画布 —— **工具只认这个抽象，不认识 Hocuspocus**。
 *
 * 实现由宿主给：apps/server 的 `agent/canvas-access.ts` 用 direct connection 打开活房间、
 * 每次读写前重查发起人权限和配额；测试用下面的 {@link createDocCanvasHandle} 直接包一个
 * 内存里的 `Y.Doc`。两种实现对工具来说没有区别，工具逻辑因此能脱离数据库和 WebSocket 单测。
 *
 * ## 写的规矩：先校验、后动手
 *
 * `write(fn)` 的 `fn` 跑在一个 Y 事务里，但 **Yjs 的事务不会回滚**：`fn` 抛异常时，
 * 抛之前已经 `set` / `delete` 的那些照样生效、照样广播。所以每个工具的 `fn` 都按
 * 「读出现状 → 校验全部前提 → 一口气改」的顺序写，异常只允许出现在第一次改动之前。
 * `fn` 是同步的，JS 单线程，校验和改动之间不会插进别人的更新。
 */
export interface CanvasHandle {
  readonly flowId: string
  /** 只读访问。实现在调 `fn` 之前做权限复核 */
  read<T>(fn: (doc: Y.Doc) => T): Promise<T>
  /**
   * 一次写 = 一个 Y 事务，origin 是 {@link agentOrigin}。
   * 实现在开事务之前做权限复核与配额检查，不过就抛 —— 一个字节都不写。
   */
  write<T>(fn: (doc: Y.Doc) => T): Promise<T>
}

/**
 * agent 写入的事务 origin（形状定义在 `@shadecn/shared/agent`）。
 *
 * 不是 `LOCAL_ORIGIN`，所以不进任何人的撤销栈；也不是 Hocuspocus 认识的
 * `connection` / `redis` / `local` 三种 —— Hocuspocus 对认不出的 origin 按「普通改动」处理：
 * 照常广播、照常进 `onChange`（配额记账、redis 转发）和防抖落库。
 */
export function agentOrigin(runId: string): AgentTransactionOrigin {
  return { source: 'agent', runId }
}

export interface DocCanvasHandleOptions {
  flowId: string
  runId: string
  /** 每次读写之前调；抛异常即拒绝。用来在测试里模拟「发起人失权」 */
  guard?: (kind: 'read' | 'write') => void | Promise<void>
}

/** 直接包一个 `Y.Doc` 的实现 —— 测试用，也是「实现长什么样」的最小参照 */
export function createDocCanvasHandle(doc: Y.Doc, options: DocCanvasHandleOptions): CanvasHandle {
  const origin = agentOrigin(options.runId)
  return {
    flowId: options.flowId,
    async read(fn) {
      await options.guard?.('read')
      return fn(doc)
    },
    async write(fn) {
      await options.guard?.('write')
      let result!: ReturnType<typeof fn>
      doc.transact(() => {
        result = fn(doc)
      }, origin)
      return result
    },
  }
}
