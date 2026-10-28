import { beforeEach, describe, expect, it } from 'vitest'
import { collabLogStats, collabLogging, resetCollabLogStats } from '../../logger/collab.ts'

/**
 * 协同日志 extension 的**统计**部分。
 *
 * 它不只是打印：`onStoreDocument`（开始）和 `afterStoreDocument`（完成）分别计数，
 * 两者的差就是落库失败次数 —— 而这正是 REQ-RESILIENCE §4.5 要的那个数，
 * 且完全靠观察得出，业务代码里一行 try/catch 都不用加。
 *
 * hook 的 payload 类型来自 Hocuspocus 且很宽，测试只喂用得上的字段。
 */

/**
 * 造一个够用的 payload；hook 只读它需要的那两三个键。
 *
 * 统计是模块级的累计值（一个进程一份，且**不随汇总清零** —— 告警要的就是累计），
 * 所以每个用例前先 `resetCollabLogStats()`。
 */
function payload(room: string, extra: Record<string, unknown> = {}) {
  return { documentName: room, clientsCount: 1, ...extra } as never
}

beforeEach(() => {
  resetCollabLogStats()
})

describe('协同日志统计', () => {
  it('落库成功 = 开始与完成配对，failed 为 0', async () => {
    const extension = collabLogging()
    try {
      await extension.onStoreDocument?.(payload('flow:a'))
      await extension.afterStoreDocument?.(payload('flow:a'))

      const stats = collabLogStats()
      expect(stats.started).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(0)
      expect(stats.lastOkAt).not.toBeNull()
    } finally {
      extension.dispose()
    }
  })

  /**
   * 这是这个 extension 存在的核心理由：落库链在中途抛出时
   * （Redis 的 redlock 拿不到锁、数据库写失败），`afterStoreDocument` 根本不会被调用，
   * 于是差值自己浮出来 —— 不需要谁去 catch 那个异常。
   */
  it('落库中途失败 → 只有开始没有完成，failed 记上一笔', async () => {
    const extension = collabLogging()
    try {
      await extension.onStoreDocument?.(payload('flow:b'))
      // afterStoreDocument 不会来 —— 链被前面的 hook 掐断了

      const stats = collabLogStats()
      expect(stats.started).toBe(1)
      expect(stats.completed).toBe(0)
      expect(stats.failed).toBe(1)
    } finally {
      extension.dispose()
    }
  })

  it('每次编辑只累加不打日志，房间卸载后计数清掉', async () => {
    const extension = collabLogging()
    try {
      const update = { update: new Uint8Array(16) }
      await extension.onChange?.(payload('flow:c', update))
      await extension.onChange?.(payload('flow:c', update))
      expect(collabLogStats().rooms).toBe(1)

      await extension.beforeUnloadDocument?.(payload('flow:c'))
      expect(collabLogStats().rooms).toBe(0)
    } finally {
      extension.dispose()
    }
  })

  /**
   * 观察者不能变成故障源：hook 链是串行的，这里抛一个异常
   * 就会把排在后面的配额、鉴权、落库全部掐掉。
   */
  it('hook 拿到残缺 payload 也不抛', async () => {
    const extension = collabLogging()
    try {
      await expect(extension.onStoreDocument?.(payload(''))).resolves.toBeUndefined()
      await expect(extension.onDisconnect?.(payload('flow:d'))).resolves.toBeUndefined()
    } finally {
      extension.dispose()
    }
  })
})
