import type { GraphEdge } from "@vue-flow/core"

/**
 * 一条边此刻要不要画成「选中」的样子：边自己被选中，或者它两端的任一节点被选中。
 *
 * 只是外观 —— 节点被选中时**不**把相连的边真的标成 selected（那样 Delete 会连边一起删、
 * 选区工具栏也会把边算进去）。连线（`FlowEdge.vue`）和两端的连接点（`FlowNodeHandles.vue`）
 * 共用这一个判断，线和点总是一起亮。
 */
export function isEdgeHighlighted(edge: Pick<GraphEdge, "selected" | "sourceNode" | "targetNode">): boolean {
  return Boolean(edge.selected || edge.sourceNode?.selected || edge.targetNode?.selected)
}
