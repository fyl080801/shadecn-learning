/**
 * 「这条连接到此为止」—— 服务端单方面终结一条协同连接。
 *
 * **必须两条腿一起走**，因为它们防的不是同一件事：
 * - `connection.close()` 是 Hocuspocus 的优雅通道 —— 把连接从文档上摘掉、跑 `onDisconnect`、
 *   并给客户端发一条 CLOSE **消息**。但它**不关 socket**。
 * - 所以还要真的关掉 socket。不关的话客户端下一条消息（awareness 心跳约 30 秒一次）
 *   会被服务端当成一次新的文档连接重新鉴权 —— 已经下线的窗口自己复活了。
 *
 * 顺带解释了前端为什么两个信号都要认：CLOSE 消息里**只有 reason**，
 * code 是 provider 自己填的 `1000`；code 只在真正的关闭帧上。
 * 所以 reason 才是那条跨得过两条腿的判据，前端两边都匹配（`useFlowCollab` 的 `classifyClose`）。
 */

export interface CloseReason {
  /** 4000–4999 是应用自定义区间；只有关闭帧带得动它 */
  code: number
  /** CLOSE 消息和关闭帧都带，所以前端主要靠它认 */
  reason: string
}

/** 被自己在别处开的新窗口顶下线（`exclusive.ts`）。刷新页面即可重新接管 */
export const CLOSE_SUPERSEDED: CloseReason = { code: 4409, reason: 'session-superseded' }

/** 会话没了（过期 / 登出 / 被踢）。reason 与 Hocuspocus 内置的 `Unauthorized` 一致 */
export const CLOSE_UNAUTHORIZED: CloseReason = { code: 4401, reason: 'Unauthorized' }

/** 人登着，但不该进这个房间：不是项目成员，或画布已删 */
export const CLOSE_REVOKED: CloseReason = { code: 4403, reason: 'permission-revoked' }

/**
 * 画布顶到内容硬限、房间锁写（`quota.ts`）。
 *
 * 和前三种不同，这一种**跟人无关** —— 同一个房间里的每个人都会收到它，因为不能保存的是
 * 这张画布本身。4413 借的是 HTTP 的 413：个人画布那条 REST 通道超限回的正是 413，
 * 前端两边归成同一个终局状态（`too-large`），文案也只写一份。
 */
export const CLOSE_QUOTA_LOCKED: CloseReason = { code: 4413, reason: 'quota-exceeded' }

/**
 * 握手被拒时抛给 Hocuspocus 的错误。
 *
 * **`onConnect` 抛异常走的不是关闭那条路** —— Hocuspocus 既不关 socket 也不发关闭码，
 * 它只回一条 `PermissionDenied` 消息，内容是 `error.reason ?? 'permission-denied'`，
 * socket 继续开着。所以拒绝原因只能挂在 `reason` 上带出去；不挂的话前端收到的永远是
 * 那句无差别的 `permission-denied`，分不清「该重新登录」还是「你已经不是成员了」。
 *
 * 用的是和关闭帧同一套 reason 字符串，前端因此可以用**同一个** `classifyClose`
 * 处理两条路（关闭事件 / 认证失败消息），不必维护两张映射表。
 */
export function denialError(event: CloseReason): Error {
  return Object.assign(new Error(`collab denied: ${event.reason}`), { reason: event.reason })
}

/**
 * 关一条连接需要的那点结构。收窄到这个形状，测试就能直接喂假对象，
 * 不用起真的 WebSocket；Hocuspocus 的 `Connection` 结构上满足它。
 */
export interface ClosableConnection {
  webSocket: { close(code?: number, reason?: string): void }
  close(event: CloseReason): void
}

/** 两条腿一起关。出错只记一笔 —— 关不掉一条已经半死的连接不该影响其余流程 */
export function closeForGood(connection: ClosableConnection, event: CloseReason): void {
  try {
    connection.close(event)
    connection.webSocket.close(event.code, event.reason)
  } catch (err) {
    console.warn(`[collab] 关闭连接（${event.reason}）时出错`, err)
  }
}
