import type { FlowNode } from "@/types/flow"
import type { FlowCommand } from "../registry"
import { clone } from "./helpers"

/** 新增节点。after 是完整的节点，undo 时交给 NodeRemoveCommand。 */
export const NodeAddCommand: FlowCommand = {
  type: "node.add",
  inverse: "node.remove",
  name: "新增节点",

  apply(ctx, op) {
    if (!op.after) return
    // 重复应用（重做撞上服务端回放）时不能加出第二个
    if (ctx.nodes.value.some((node) => node.id === op.targetId)) return

    ctx.nodes.value = [...ctx.nodes.value, clone(op.after) as FlowNode]
  }
}
