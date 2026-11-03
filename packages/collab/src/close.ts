import type { CloseReason } from '@learning/contracts/collab'

/**
 * 「这条连接到此为止」：服务端单方面终结一条协同连接，**必须两条腿一起走**：
 * - `connection.close()` 把连接从文档上摘掉、跑 `onDisconnect`、给客户端发一条 CLOSE **消息**，但**不关 socket**；
 * - 不关 socket 的话，客户端下一条消息（awareness 心跳）会被当成一次新的文档连接重新鉴权，已经下线的窗口自己复活。
 *
 * CLOSE 消息只带 reason（code 是 provider 自己填的 1000），code 只在真正的关闭帧上，所以前端靠 reason 判（`classifyClose`）。
 */

/**
 * 握手被拒时抛给 Hocuspocus 的错误。`onConnect` 抛异常**不走关闭那条路**：不关 socket、没有关闭码，只回一条 `PermissionDenied`，
 * 内容是 `error.reason ?? 'permission-denied'`。所以原因只能挂在 `reason` 上，用和关闭帧同一套字符串，前端用同一个 `classifyClose` 处理两条路。
 */
export function denialError(event: CloseReason): Error {
  return Object.assign(new Error(`collab denied: ${event.reason}`), { reason: event.reason })
}

/** 关一条连接需要的那点结构：测试能喂假对象，Hocuspocus 的 `Connection` 结构上满足它 */
export interface ClosableConnection {
  webSocket: { close(code?: number, reason?: string): void }
  close(event: CloseReason): void
}

/** 两条腿一起关。出错只记一笔：关不掉一条半死的连接不该影响其余流程 */
export function closeForGood(connection: ClosableConnection, event: CloseReason): void {
  try {
    connection.close(event)
    connection.webSocket.close(event.code, event.reason)
  } catch (err) {
    console.warn(`[collab] 关闭连接（${event.reason}）时出错`, err)
  }
}
