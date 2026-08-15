import type { FlowCommand } from "../registry"

/**
 * 删除节点。before 存着完整节点，撤销时原样加回来。
 *
 * 连着的边**不在这里代劳** —— 调用方要把 edge.remove 放进同一个事务，
 * 这样撤销时边和节点会一起回来，顺序也对（invertOps 会把顺序倒过来）。
 */
export const NodeRemoveCommand: FlowCommand = {
  type: "node.remove",
  inverse: "node.add",
  name: "删除节点",

  apply(ctx, op) {
    ctx.nodes.value = ctx.nodes.value.filter((node) => node.id !== op.targetId)
  }
}
