import type { FlowCommand } from "../registry"
import { patchNode } from "./helpers"

/**
 * 改节点的业务数据（label / description / config …）。自逆。
 *
 * before / after 给的是 `{ data: { …只写改动的键 } }`：patchNode 会做浅合并，
 * 所以只改 label 不会把 config 带没。
 */
export const NodeUpdateCommand: FlowCommand = {
  type: "node.update",
  inverse: "node.update",
  name: "修改节点",

  apply: patchNode
}
