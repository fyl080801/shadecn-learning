import type { CollabDenialReason } from './collab-auth.js'

/**
 * 写操作的认证闸门：登录态没了、人被移出项目之后的编辑，**在进 Y.Doc 之前**拦住。
 * `onConnect` 只跑一次，复验是连接级动作，而关闭落地之前排在队列里的帧照样会被应用、广播、落库，别人还撤销不回来。
 *
 * 挂在 `beforeSync` 而不是 `beforeHandleMessage`：只有写帧付成本（awareness 不经过），而且它跑在 Hocuspocus 的 `readOnly` 检查之前，在这里置只读能 NACK 当前这一帧。
 * **不拦 SyncStep1**（读）：拦了重连的同步握手都做不成。**不抛错**：抛出去连接被关，provider 重连后重发同一条，死循环。
 * **判定缓存成 Promise（顺带去重），不攒批不延迟**：一条连接的消息是串行队列，await 一个定时器会把 awareness 心跳也堵住，30 秒后被判死。
 * TTL 可以长：权限撤销是事件驱动的（复验开头 {@link WriteGate.clear}），TTL 只兜底登录态。
 */

/** y-protocols/sync 的消息类型：线协议的一部分，写成字面量省一个依赖 */
const SYNC_STEP_1 = 0
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/** 这条 sync 消息是要写吗（SyncStep1 是客户端来问「你有什么我没有的」，是读） */
export function isWriteSync(type: number): boolean {
  return type === SYNC_STEP_2 || type === SYNC_UPDATE
}

/** 只在测试里用得上 */
export const SYNC_MESSAGE_TYPES = { step1: SYNC_STEP_1, step2: SYNC_STEP_2, update: SYNC_UPDATE } as const

export const WRITE_VERDICT_TTL = 10_000

/** `null` = 放行 */
export type WriteVerdict = CollabDenialReason | null

/** 查什么由调用方注入：闸门不认识「项目」 */
export type AuthorizeWrite = (cookie: string | null, room: string) => Promise<WriteVerdict>

export interface WriteGateOptions {
  /** 必填，没有默认值：选择摆在调用点上 */
  authorize: AuthorizeWrite
  ttlMs?: number
  /** 注入时钟；测 TTL 用 */
  now?: () => number
}

export interface WriteGate {
  /** 这条连接现在还能写吗。`null` = 能 */
  check(socketId: string, room: string, cookie: string | null): Promise<WriteVerdict>
  /** 握手刚认证过，把结论直接填进去 */
  prime(socketId: string): void
  forget(socketId: string): void
  /** 全表作废：复验（含主动撤销）跑之前调 */
  clear(): void
  size(): number
}

export function createWriteGate(options: WriteGateOptions): WriteGate {
  const { authorize, ttlMs = WRITE_VERDICT_TTL, now = Date.now } = options
  // key 不加实例前缀：这张表是进程内缓存，socketId 在进程内已经唯一
  const entries = new Map<string, { at: number; verdict: Promise<WriteVerdict> }>()

  return {
    check(socketId, room, cookie) {
      const cached = entries.get(socketId)
      if (cached && now() - cached.at < ttlMs) return cached.verdict

      const verdict = authorize(cookie, room).catch((err: unknown) => {
        // 抛异常 = 基础设施出问题，证明不了任何事：放行。基础设施抖一下就让所有人写不了，比多放行一帧糟得多
        console.warn(`[collab] ${room} 的写入鉴权失败，本帧放行`, err)
        return null
      })
      entries.set(socketId, { at: now(), verdict })
      return verdict
    },
    prime(socketId) {
      entries.set(socketId, { at: now(), verdict: Promise.resolve(null) })
    },
    forget(socketId) {
      entries.delete(socketId)
    },
    clear() {
      entries.clear()
    },
    size: () => entries.size,
  }
}
