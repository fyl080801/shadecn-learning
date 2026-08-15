import type { FlowCommand } from "../registry"
import { patchNode } from "./helpers"

/** 改节点尺寸。before / after 都是 `{ width, height }`，自逆。 */
export const NodeResizeCommand: FlowCommand = {
  type: "node.resize",
  inverse: "node.resize",
  name: "调整节点尺寸",

  apply: patchNode
}
