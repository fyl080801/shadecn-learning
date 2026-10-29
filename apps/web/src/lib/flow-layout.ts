import { Graph, layout } from "@dagrejs/dagre"

/** 参与布局的一个盒子：左上角坐标之外的东西都不需要 */
export interface LayoutBox {
  id: string
  width: number
  height: number
}

export interface LayoutLink {
  source: string
  target: string
}

/** 同一列里上下相邻两个节点的间距 */
export const LAYOUT_NODE_GAP = 48

/** 相邻两列之间的间距（连线从这里穿过，比上下留得宽） */
export const LAYOUT_RANK_GAP = 120

/**
 * 横向（从左到右）分层布局，算法是 dagre —— 同 Vue Flow 的 layout 示例。
 *
 * 返回每个盒子的**左上角**（dagre 给的是中心点，这里换算掉），取整避免小数坐标进文档。
 * 两端有一头不在 `boxes` 里的连线、自环一律忽略；没有连线的盒子会各自占一层排在一起。
 * 纯函数，不认识 Vue Flow 也不认识 store。
 */
export function layoutHorizontal(
  boxes: readonly LayoutBox[],
  links: readonly LayoutLink[]
): Map<string, { x: number; y: number }> {
  const graph = new Graph()
  graph.setGraph({ rankdir: "LR", nodesep: LAYOUT_NODE_GAP, ranksep: LAYOUT_RANK_GAP })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const box of boxes) {
    graph.setNode(box.id, { width: box.width, height: box.height })
  }
  for (const link of links) {
    if (link.source === link.target) continue
    if (!graph.hasNode(link.source) || !graph.hasNode(link.target)) continue
    graph.setEdge(link.source, link.target)
  }

  layout(graph)

  const positions = new Map<string, { x: number; y: number }>()
  for (const box of boxes) {
    const { x, y } = graph.node(box.id)
    positions.set(box.id, {
      x: Math.round(x - box.width / 2),
      y: Math.round(y - box.height / 2)
    })
  }
  return positions
}
