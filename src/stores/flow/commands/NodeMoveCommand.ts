import type { FlowCommand } from "../registry"
import { patchNode } from "./helpers"

/**
 * 移动节点。before / after 都是 `{ position }`，自逆。
 *
 * 拖拽过程中的中间态不产生这条命令 —— 编辑器在 nodeDragStop 时才用
 * 起点和终点合成一条，所以一次拖动 = 一次撤销。
 */
export const NodeMoveCommand: FlowCommand = {
  type: "node.move",
  inverse: "node.move",
  name: "移动节点",

  apply: patchNode
}
