import type { FlowEdge } from "@/types/flow"
import type { FlowCommand } from "../registry"
import { clone } from "./helpers"

/** 新增连线。after 是完整的边。 */
export const EdgeAddCommand: FlowCommand = {
  type: "edge.add",
  inverse: "edge.remove",
  name: "新增连线",

  apply(ctx, op) {
    if (!op.after) return
    if (ctx.edges.value.some((edge) => edge.id === op.targetId)) return

    ctx.edges.value = [...ctx.edges.value, clone(op.after) as FlowEdge]
  }
}
