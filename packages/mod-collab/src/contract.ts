import { bus, defineRequest } from '@shadecn/server-kit/bus'

/**
 * 协同能力对外的契约（REQ-MODULES，docs/28 §3.7）：别的模块 / 底座路由要协同做事，只经这里。
 * 它不 import 协同的实现 —— 只有总线令牌和薄薄一层调用，web 角色的进程里可以完全没有 Hocuspocus。
 */

/** 把某张画布还开着的房间立刻落一次库（带投影）。回话的值没有含义，到了就说明「这个实例上的那份已经写进库了」 */
export const COLLAB_FLUSH_ROOM = defineRequest<{ flowId: string }, null>('collab.flush-room')

/** 等协同回话的上限：一次落库是读 → 合并 → CAS 写，正常几十毫秒；超时就按「没开着」读库 */
export const FLUSH_ROOM_TIMEOUT_MS = 5_000

/**
 * 凡是要**读库里的画布内容**再做事的接口（复制画布…）先调它：内容的事实源是内存里的 Y.Doc，
 * 库里那份只在防抖窗口和散场时更新，不叫一次就拿到上一次写入时的样子。
 *
 * 发给**所有**协同实例（房间可能同时开在好几个副本上），等它们回话或超时。**从不抛错**：
 * 没有协同实例、某个实例超时或落库失败，都只记一笔然后照常往下走 —— 调用方读到的最差是上一次落库的内容，
 * 和改造前「房间开在别的副本上」时一样（docs/28 §3.7「请求-应答必须有退路」）。
 */
export async function flushRoom(flowId: string): Promise<void> {
  try {
    const result = await bus().request(COLLAB_FLUSH_ROOM, { flowId }, { timeoutMs: FLUSH_ROOM_TIMEOUT_MS })
    if (result.missing.length > 0 || result.failures.length > 0) {
      console.warn(
        `[collab] 画布 ${flowId} 落库请求未全部完成（超时 ${result.missing.join(',') || '无'}；失败 ${
          result.failures.map((item) => `${item.instance}: ${item.error}`).join('; ') || '无'
        }），按库里现有内容继续`,
      )
    }
  } catch (err) {
    console.warn(`[collab] 画布 ${flowId} 落库请求失败，按库里现有内容继续`, err)
  }
}
