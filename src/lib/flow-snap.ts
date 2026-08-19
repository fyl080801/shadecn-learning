/**
 * 画布吸附的纯几何部分：**网格吸附**和**辅助线吸附**。
 *
 * 这里不认识 Vue Flow，也不认识 Vue —— 进来的是矩形，出去的是「该挪多少」
 * 加上「画哪几条辅助线」。拖动过程中每帧都要跑，所以只做加减比较，不建中间对象。
 *
 * 两种吸附的定位不同：
 * - **网格**：把左上角对到网格上，和参照物无关，任何时候都算得出来；
 * - **辅助线**：拿自己的左/中/右（上/中/下）去和别的节点对齐，只有真的对上了才吸，
 *   并且要把对上的那条线画出来，用户才知道自己被什么吸住了。
 *
 * 两者同时开的时候**辅助线赢**：先按网格量化，再让对齐把位置拉到线上 ——
 * 对齐是更明确的意图，被网格拽回去反而是错的。
 */

/** 一个参与吸附的矩形（画布坐标，`x`/`y` 是左上角） */
export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}

/** 竖线 = 沿 x 轴对齐，横线 = 沿 y 轴对齐 */
export type SnapGuideOrientation = "vertical" | "horizontal"

/** 一条要画出来的辅助线 */
export interface SnapGuide {
  orientation: SnapGuideOrientation
  /** 竖线的 x / 横线的 y */
  position: number
  /** 线段两端：竖线是 y 范围，横线是 x 范围 */
  start: number
  end: number
}

export interface SnapOptions {
  /** 网格大小；`0` 表示不吸网格 */
  grid: number
  /** 辅助线的容差（**画布坐标**，调用方负责按缩放折算）；`<= 0` 表示不吸辅助线 */
  threshold: number
}

export interface SnapOutcome {
  /** 要施加到被拖元素上的位移 */
  delta: { x: number; y: number }
  /** 本次吸附对上的辅助线（没吸上就是空数组） */
  guides: SnapGuide[]
}

type Axis = "x" | "y"

/** 判定「这个目标也压在同一条线上」的容差 —— 吸附之后自己那条线是精确相等的 */
const SAME_LINE_EPSILON = 0.5

function span(rect: SnapRect, axis: Axis) {
  const start = axis === "x" ? rect.x : rect.y
  const size = axis === "x" ? rect.width : rect.height
  return { start, center: start + size / 2, end: start + size }
}

/** 一个矩形在某个轴上的三条候选线：起边、中线、终边 */
function linesOf(rect: SnapRect, axis: Axis): [number, number, number] {
  const { start, center, end } = span(rect, axis)
  return [start, center, end]
}

/** 把一个数对到网格上 */
export function snapValueToGrid(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value
}

/**
 * 单轴的对齐搜索：自己的三条线 × 每个目标的三条线，取**偏移最小**的那一对。
 *
 * 返回的 `position` 是对上的那条线的坐标（用来画辅助线），没吸上就是 `null`。
 */
function alignAxis(
  moving: SnapRect,
  targets: readonly SnapRect[],
  threshold: number,
  axis: Axis
): { delta: number; position: number | null } {
  if (threshold <= 0) return { delta: 0, position: null }

  const mine = linesOf(moving, axis)
  let best: { delta: number; position: number } | null = null

  for (const target of targets) {
    for (const line of linesOf(target, axis)) {
      for (const own of mine) {
        const delta = line - own
        if (Math.abs(delta) > threshold) continue
        // 严格小于：偏移一样时保留先找到的那条，也就是「起边优先于中线优先于终边」
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, position: line }
      }
    }
  }

  return best ?? { delta: 0, position: null }
}

/**
 * 把对齐结果变成一条要画的线。
 *
 * 线的长度覆盖「我」和**所有**压在这条线上的目标 —— 不止吸中的那一个：
 * 三个节点左边对齐时，一条贯穿三者的线才说明发生了什么。
 */
function buildGuide(
  moving: SnapRect,
  targets: readonly SnapRect[],
  axis: Axis,
  position: number | null
): SnapGuide[] {
  if (position === null) return []

  const cross: Axis = axis === "x" ? "y" : "x"
  const own = span(moving, cross)
  let start = own.start
  let end = own.end
  let matched = false

  for (const target of targets) {
    if (!linesOf(target, axis).some((line) => Math.abs(line - position) < SAME_LINE_EPSILON)) {
      continue
    }
    matched = true
    const range = span(target, cross)
    start = Math.min(start, range.start)
    end = Math.max(end, range.end)
  }

  if (!matched) return []
  return [{ orientation: axis === "x" ? "vertical" : "horizontal", position, start, end }]
}

/**
 * 算出被拖矩形该挪多少、以及要画哪几条辅助线。
 *
 * `moving` 是被拖元素当前的位置（多选拖动时传它们的**外接矩形**，
 * 得到的位移原样施加到每一个上，相对关系才不会被拆散）。
 */
export function computeSnap(
  moving: SnapRect,
  targets: readonly SnapRect[],
  options: SnapOptions
): SnapOutcome {
  const delta = { x: 0, y: 0 }

  if (options.grid > 0) {
    delta.x = snapValueToGrid(moving.x, options.grid) - moving.x
    delta.y = snapValueToGrid(moving.y, options.grid) - moving.y
  }

  if (options.threshold <= 0 || targets.length === 0) {
    return { delta, guides: [] }
  }

  // 对齐是在「网格吸附之后」的位置上判定的，所以两者叠加不会互相打架
  const gridded: SnapRect = { ...moving, x: moving.x + delta.x, y: moving.y + delta.y }
  const alignedX = alignAxis(gridded, targets, options.threshold, "x")
  const alignedY = alignAxis(gridded, targets, options.threshold, "y")

  delta.x += alignedX.delta
  delta.y += alignedY.delta

  // 辅助线要画在**最终**位置上，所以等两个轴都定了再算
  const settled: SnapRect = { ...moving, x: moving.x + delta.x, y: moving.y + delta.y }

  return {
    delta,
    guides: [
      ...buildGuide(settled, targets, "x", alignedX.position),
      ...buildGuide(settled, targets, "y", alignedY.position)
    ]
  }
}

/** 一组矩形的外接矩形；空数组返回 `null` */
export function boundingRect(rects: readonly SnapRect[]): SnapRect | null {
  if (rects.length === 0) return null

  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity

  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}
