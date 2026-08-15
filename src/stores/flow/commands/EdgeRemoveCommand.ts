import type { FlowCommand } from "../registry"

/** 删除连线。before 存着完整的边，撤销时原样加回来。 */
export const EdgeRemoveCommand: FlowCommand = {
  type: "edge.remove",
  inverse: "edge.add",
  name: "删除连线",

  apply(ctx, op) {
    ctx.edges.value = ctx.edges.value.filter((edge) => edge.id !== op.targetId)
  }
}
