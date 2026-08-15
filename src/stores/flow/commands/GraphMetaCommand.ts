import type { FlowCommand } from "../registry"

/**
 * 改画布级的自定义数据（`graph.meta`）。自逆。
 *
 * 这里是整体替换而不是合并：meta 的形状完全由业务定，
 * 合并语义会让「删掉一个键」变得没法表达。
 */
export const GraphMetaCommand: FlowCommand = {
  type: "graph.meta",
  inverse: "graph.meta",
  name: "修改画布数据",

  apply(ctx, op) {
    ctx.graphMeta.value = { ...((op.after ?? {}) as Record<string, unknown>) }
  }
}
