import type { FlowUserState } from '@shadecn/shared/flow-graph'
import { db } from '../db.ts'
import { FlowUserState as FlowUserStateRow, newId } from '../db/entities/index.ts'
import { FLOW_USER_STATE_PARSERS } from './flow-types.ts'

/**
 * 「每人自己一份」的画布状态（视口、以后的面板开合…）。
 *
 * 一行 = 一个人在一张画布上的一个分区（key），值是 JSON 字符串。
 * 加一种要存的东西不用改这里，也不用改表 —— 在 `@shadecn/shared/flow-graph` 的
 * `FlowUserState` 上加字段、再在 flow-types.ts 的 FLOW_USER_STATE_PARSERS 里加一行就够。
 */

export const flowUserState = {
  /** 取某人在某张画布上的全部分区；没存过的 key 不出现在结果里 */
  async get(flowId: string, userId: string): Promise<FlowUserState> {
    const rows = await db().find(
      FlowUserStateRow,
      { flow: flowId, user: userId },
      { fields: ['key', 'value'] },
    )

    // 库里的 key 是任意字符串，先按普通对象收，认得的才放进来
    const state: Record<string, unknown> = {}
    for (const row of rows) {
      // 现在不认识的 key（老版本存的、或已经下线的分区）直接跳过，不回给前端
      if (!(row.key in FLOW_USER_STATE_PARSERS)) continue
      try {
        state[row.key] = JSON.parse(row.value) as unknown
      } catch {
        // 坏数据当没存过：这类状态丢了只是回到默认视图，不值得报错
      }
    }
    return state as FlowUserState
  },

  /**
   * PATCH 语义：只覆盖 patch 里出现的分区，其余的原样留着。
   * 入参必须已经过 parseUserStatePatch（key 合法、值合法、体积达标）。
   */
  async patch(flowId: string, userId: string, patch: FlowUserState): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      // upsert 直接发 SQL，不走工作单元：id / updatedAt 的 onCreate、onUpdate 都不会触发，得自己给。
      // 撞上 (flow, user, key) 时只改 value 和 updatedAt —— id 留着原来那个
      await db().upsert(
        FlowUserStateRow,
        {
          id: newId(),
          flow: flowId,
          user: userId,
          key,
          value: JSON.stringify(value),
          updatedAt: new Date(),
        },
        {
          onConflictFields: ['flow', 'user', 'key'],
          onConflictMergeFields: ['value', 'updatedAt'],
        },
      )
    }
  },
}
