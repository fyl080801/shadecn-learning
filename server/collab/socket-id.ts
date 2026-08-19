import { instanceId } from '../config.ts'

/**
 * 给 socketId 加上实例前缀，得到一条连接的**全局唯一标识**。
 *
 * Hocuspocus 的 socketId 只在**单个进程**里唯一，多副本下两个实例迟早撞号。
 * 两个地方拿它当身份用，撞号都会出错：
 * - awareness 的 clientID 归属登记（`awareness.ts`）—— 正主的更新会被当成冒用丢掉；
 * - 单连接互斥的持有者登记（`exclusive.ts`）—— 会把别人那条连接错认成自己的。
 *
 * 单独成一个模块只是为了让这两处共用同一个定义，别各写各的。
 */
export function scopedSocketId(socketId: string): string {
  return `${instanceId}:${socketId}`
}
