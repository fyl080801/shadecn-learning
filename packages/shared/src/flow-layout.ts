import { Graph, layout } from '@dagrejs/dagre'

/**
 * 画布布局的纯几何 —— 自动布局（dagre）和分组框的外接矩形。编辑器（`useFlowCanvas`）和
 * agent（`packages/agent/src/tools.ts`，经 `@shadecn/shared/flow-ops`）用的是同一份算法和常量。
 *
 * **尺寸都是参数**：编辑器传 Vue Flow 实测的 `dimensions`；服务端没有 DOM，传
 * `nodeSizeOf(record)`（`@shadecn/shared/flow-node-types`：布局里存的宽高，没有就按类型估）——
 * 所以 agent 排出来、圈出来的结果和人在界面上点出来的可能差几十像素（docs/20 §3.10.1）。
 *
 * 纯函数，不认识 Vue Flow、store，也不认识 Y.Doc。
 */

export interface LayoutPoint {
  x: number
  y: number
}

export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

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
 */
export function layoutHorizontal(
  boxes: readonly LayoutBox[],
  links: readonly LayoutLink[],
): Map<string, LayoutPoint> {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: LAYOUT_NODE_GAP, ranksep: LAYOUT_RANK_GAP })
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

  const positions = new Map<string, LayoutPoint>()
  for (const box of boxes) {
    const { x, y } = graph.node(box.id)
    positions.set(box.id, {
      x: Math.round(x - box.width / 2),
      y: Math.round(y - box.height / 2),
    })
  }
  return positions
}

/** 自动布局要知道的一个节点：位置、所属分组、尺寸 */
export interface LayoutNode {
  id: string
  /** 所在分组；顶层节点没有（空串也按没有算，和 Vue Flow 一致） */
  parentNode?: string
  position: LayoutPoint
  width: number
  height: number
}

/**
 * 整张画布的自动布局，返回**位置真的变了**的那些顶层节点的新位置（调用方一笔 `moveNodes` 写进去 = 一条撤销）。
 *
 * 只排**顶层**节点：分组框连同里面的节点当成一个盒子整体挪（子节点的坐标相对分组，不用动）；
 * 连到组内节点的线按它所在的顶层分组计。父节点不在 `nodes` 里的子节点既不参与、也不代表谁。
 */
export function planAutoLayout(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[],
): Map<string, LayoutPoint> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const topLevel = nodes.filter((node) => !node.parentNode)
  if (topLevel.length === 0) return new Map()

  /** 节点所在的顶层祖先（自己就是顶层时返回自己）；父链断了停在断处，成环时停下 */
  const rootOf = (id: string): string => {
    let node = byId.get(id)
    const seen = new Set<string>()
    while (node?.parentNode && !seen.has(node.id)) {
      seen.add(node.id)
      const parent = byId.get(node.parentNode)
      if (!parent) break
      node = parent
    }
    return node?.id ?? id
  }

  const positions = layoutHorizontal(
    topLevel.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    links.map((link) => ({ source: rootOf(link.source), target: rootOf(link.target) })),
  )

  const moved = new Map<string, LayoutPoint>()
  for (const node of topLevel) {
    const next = positions.get(node.id)
    if (next && (next.x !== node.position.x || next.y !== node.position.y)) moved.set(node.id, next)
  }
  return moved
}

// —— 分组框 ——

/** 分组框在被圈住的节点之外留的余量 */
export const GROUP_PADDING = 32

/** 顶上再多留一条，给分组自己的标题栏腾地方，免得压在第一个节点的名字上 */
export const GROUP_HEADER = 20

/** 一批矩形的外接矩形；一个都没有返回 null */
export function boundingRect(rects: Iterable<LayoutRect>): LayoutRect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let any = false
  for (const rect of rects) {
    any = true
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  return any ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null
}

/** 罩住 `rect` 的分组框：四周留 {@link GROUP_PADDING}，顶上再多留 {@link GROUP_HEADER} */
export function groupFrameAround(rect: LayoutRect): LayoutRect {
  return {
    x: rect.x - GROUP_PADDING,
    y: rect.y - GROUP_PADDING - GROUP_HEADER,
    width: rect.width + GROUP_PADDING * 2,
    height: rect.height + GROUP_PADDING * 2 + GROUP_HEADER,
  }
}
