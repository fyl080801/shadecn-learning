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

// —— 分组边界 ——
//
// 分组的边界（docs/13 §4.4）：组里的节点出不去 —— 拖到边上，**框跟着长**；组外的节点拖到分组上
// （中心点落进框里）就**加入**这个分组，框重新罩一遍。分组框盖到别的节点上则什么都不发生。
// 编辑器（实测尺寸）和 agent（`nodeSizeOf` 估的尺寸，在沙箱外的服务端执行）都经 `flow-ops` 调这里，同一份规则。

export interface GroupFit {
  /** 长完之后的分组框（画布坐标）；不用长就和传进来的一样 */
  frame: LayoutRect
  /**
   * 组员的相对坐标要加上的量：框往左 / 往上长时左上角挪了，组员的相对坐标不跟着补，
   * 它们在画面上就会跟着框一起跑。都是 ≥ 0 的数。
   */
  shift: LayoutPoint
}

/**
 * 分组框要多大才罩得住它的组员 —— **只长不缩**：组员（相对框左上角的矩形）连同留白
 * （四周 {@link GROUP_PADDING}，顶上再加 {@link GROUP_HEADER}，和 {@link groupFrameAround} 同一套）
 * 超出哪边就往哪边长；框本身比组员大（人拉大的）保持不动。没有组员原样返回。
 */
export function fitGroupFrame(frame: LayoutRect, children: Iterable<LayoutRect>): GroupFit {
  const bounds = boundingRect(children)
  if (!bounds) return { frame: { ...frame }, shift: { x: 0, y: 0 } }
  const need = groupFrameAround(bounds)
  const shift = { x: Math.max(0, -need.x), y: Math.max(0, -need.y) }
  const width = Math.max(frame.width + shift.x, need.x + need.width + shift.x)
  const height = Math.max(frame.height + shift.y, need.y + need.height + shift.y)
  return {
    frame: { x: frame.x - shift.x, y: frame.y - shift.y, width, height },
    shift,
  }
}

/** 一个候选的分组框（顶层，画布坐标） */
export interface GroupCandidate {
  id: string
  rect: LayoutRect
}

/**
 * 一个顶层节点落在 `rect` 时该加入哪个分组：**节点的中心点**落在哪个分组框里（含边线），
 * 落在几个叠着的框里取面积最小的那个（最贴近人指的那一块）；都不在返回 null。
 *
 * 用中心点而不是「有没有叠上」：蹭到框边不算拖进去，节点大半进了框才算 —— 人和 agent 同一个口径
 * （agent 没有指针，只能按节点自己的位置判）。
 */
export function groupUnderNode(rect: LayoutRect, groups: Iterable<GroupCandidate>): string | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best: GroupCandidate | null = null
  for (const group of groups) {
    const r = group.rect
    if (cx < r.x || cx > r.x + r.width || cy < r.y || cy > r.y + r.height) continue
    if (!best || r.width * r.height < best.rect.width * best.rect.height) best = group
  }
  return best?.id ?? null
}

/**
 * 往分组里放一个新组员、没指定位置时放哪（相对框左上角）：现有组员的下面隔一个 {@link LAYOUT_NODE_GAP}，
 * 左边对齐留白；空组放在留白（含标题栏）之后的第一格。框够不够大不归这里管 —— 落定时框自己会长。
 */
export function nextSlotInGroup(children: Iterable<LayoutRect>): LayoutPoint {
  const bounds = boundingRect(children)
  if (!bounds) return { x: GROUP_PADDING, y: GROUP_PADDING + GROUP_HEADER }
  return { x: bounds.x, y: bounds.y + bounds.height + LAYOUT_NODE_GAP }
}

// —— 组内排列 ——

/** 分组工具栏「布局」菜单的三种排法 */
export type GroupArrangement = 'horizontal' | 'vertical' | 'grid'

export const GROUP_ARRANGEMENTS: readonly GroupArrangement[] = ['horizontal', 'vertical', 'grid']

/** 要排的一个组员：相对分组框左上角的位置 + 尺寸 */
export interface ArrangeMember {
  id: string
  position: LayoutPoint
  width: number
  height: number
}

export interface GroupArrangementPlan {
  /** 每个组员的新位置（相对分组框左上角） */
  positions: Map<string, LayoutPoint>
  /** 分组框正好罩住排好的组员时的尺寸（留白和 {@link groupFrameAround} 同一套）；没有组员为 null */
  size: { width: number; height: number } | null
}

/**
 * 把一个分组里的组员重新排一遍（相对分组框左上角，从留白之后的第一格开始，间距 {@link LAYOUT_NODE_GAP}）：
 *
 * - `horizontal`：排成一行，顶边对齐，按现在的 x（再按 y）从左到右；
 * - `vertical`：排成一列，左边对齐，按现在的 y（再按 x）从上到下；
 * - `grid`：宫格，列数 `ceil(√n)`，按阅读顺序（先 y 后 x）逐行填；每列宽取该列最宽、每行高取该行最高，节点贴格子左上角。
 *
 * 顺序取现在的位置，所以人先大致摆一下再点，排出来的顺序就是他想要的。坐标取整。
 */
export function planGroupArrangement(
  members: readonly ArrangeMember[],
  arrangement: GroupArrangement,
): GroupArrangementPlan {
  const positions = new Map<string, LayoutPoint>()
  if (members.length === 0) return { positions, size: null }

  const byX = (a: ArrangeMember, b: ArrangeMember) => a.position.x - b.position.x || a.position.y - b.position.y
  const byY = (a: ArrangeMember, b: ArrangeMember) => a.position.y - b.position.y || a.position.x - b.position.x
  const ordered = [...members].sort(arrangement === 'horizontal' ? byX : byY)

  const columns =
    arrangement === 'horizontal' ? ordered.length : arrangement === 'vertical' ? 1 : Math.ceil(Math.sqrt(ordered.length))
  const rows = Math.ceil(ordered.length / columns)
  const cellOf = (index: number) => ({ col: index % columns, row: Math.floor(index / columns) })
  const colWidths = Array.from({ length: columns }, (_, col) =>
    Math.max(0, ...ordered.filter((_, index) => cellOf(index).col === col).map((member) => member.width)),
  )
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(0, ...ordered.filter((_, index) => cellOf(index).row === row).map((member) => member.height)),
  )
  /** 第 `at` 格的起点 = 起始留白 + 前面各格的尺寸和间距 */
  const offset = (sizes: readonly number[], at: number, start: number) =>
    sizes.slice(0, at).reduce((sum, size) => sum + size + LAYOUT_NODE_GAP, start)

  const rects: LayoutRect[] = []
  ordered.forEach((member, index) => {
    const { col, row } = cellOf(index)
    const at = {
      x: Math.round(offset(colWidths, col, GROUP_PADDING)),
      y: Math.round(offset(rowHeights, row, GROUP_PADDING + GROUP_HEADER)),
    }
    positions.set(member.id, at)
    rects.push({ ...at, width: member.width, height: member.height })
  })

  const content = boundingRect(rects)
  const frame = content ? groupFrameAround(content) : null
  return {
    positions,
    size: frame ? { width: Math.round(frame.width), height: Math.round(frame.height) } : null,
  }
}
