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
 * 所以 reason 才是那条跨得过两条腿的判据，前端两边都匹配（`sync/collab.ts` 的 `classifyClose`）。
 */

import type { CloseReason } from '@shadecn/shared/collab'

/**
 * 四种终局信号（code + reason）声明在 `@shadecn/shared/collab` —— 前端的 `classifyClose`
 * 认的是同一份常量。这里转出去，服务端各处照旧从本模块取。
 */
export {
  CLOSE_QUOTA_LOCKED,
  CLOSE_REVOKED,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  type CloseReason,
} from '@shadecn/shared/collab'

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
