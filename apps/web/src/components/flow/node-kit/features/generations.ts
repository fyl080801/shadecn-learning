import { readGenerations } from "@shadecn/shared/flow-node-types"

import { defineNodeFeature, defineNodePart, ORDER_FEATURE, type NodePartContext } from "../protocol"
import GenerationCount from "./GenerationCount.vue"
import GenerationHistory from "./GenerationHistory.vue"

/**
 * 生成历史（媒体节点）：每次生成成功，服务端在节点 `data` 上留一条 `gen.<taskId>`（shared `recordGeneration`）。
 *
 * - 右上角（badge 区）一枚计数 —— 历史**至少两条**才有（只有一张图没得挑，不显示计数也不显示历史）、悬停节点才显示，点它展开 / 收起历史；
 * - 历史在节点右侧画布里（`aside` 区，和节点垂直居中、高度随条数增长到上限后滚动、正方形缩略图），点一条就把它换成主图（`selectGeneration`，一步撤销）。
 *   展开时右边的连接点和加号挪到历史外面（宿主量 aside 宽度，`connectable` 读 `ctx.asideWidth`）。
 *
 * 展开与否是本地 UI 状态（`ctx.slots`），不进文档。
 */
function generationsOf(ctx: NodePartContext) {
  return readGenerations(ctx.node.data.value)
}

/** 历史里至少两条才有得挑：计数和历史面板都按它出现 */
const hasChoices = (ctx: NodePartContext) => generationsOf(ctx).length > 1

export const generationsFeature = defineNodeFeature({
  id: "generations",
  parts: [
    defineNodePart({
      id: "generations.count",
      slot: "badge",
      order: ORDER_FEATURE,
      component: GenerationCount,
      when: hasChoices
    }),
    defineNodePart({
      id: "generations.history",
      slot: "aside",
      component: GenerationHistory,
      when: hasChoices
    })
  ]
})
