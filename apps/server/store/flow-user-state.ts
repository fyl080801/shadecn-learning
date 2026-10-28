import { prisma } from '../db.ts'
import { FLOW_USER_STATE_PARSERS, type FlowUserState } from './flow-types.ts'

/**
 * 「每人自己一份」的画布状态（视口、以后的面板开合…）。
 *
 * 一行 = 一个人在一张画布上的一个分区（key），值是 JSON 字符串。
 * 加一种要存的东西不用改这里，也不用改表 —— 在 flow-types.ts 的
 * FLOW_USER_STATE_PARSERS 里加一行就够。
 */

export const flowUserState = {
  /** 取某人在某张画布上的全部分区；没存过的 key 不出现在结果里 */
  async get(flowId: string, userId: string): Promise<FlowUserState> {
    const rows = await prisma.flowUserState.findMany({
      where: { flowId, userId },
      select: { key: true, value: true },
    })

    const state: FlowUserState = {}
    for (const row of rows) {
      // 现在不认识的 key（老版本存的、或已经下线的分区）直接跳过，不回给前端
      if (!(row.key in FLOW_USER_STATE_PARSERS)) continue
      try {
        state[row.key] = JSON.parse(row.value) as unknown
      } catch {
        // 坏数据当没存过：这类状态丢了只是回到默认视图，不值得报错
      }
    }
    return state
  },

  /**
   * PATCH 语义：只覆盖 patch 里出现的分区，其余的原样留着。
   * 入参必须已经过 parseUserStatePatch（key 合法、值合法、体积达标）。
   */
  async patch(flowId: string, userId: string, patch: FlowUserState): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      const serialized = JSON.stringify(value)
      await prisma.flowUserState.upsert({
        where: { flowId_userId_key: { flowId, userId, key } },
        update: { value: serialized },
        create: { flowId, userId, key, value: serialized },
      })
    }
  },
}
