import { Position } from "@vue-flow/core"

/**
 * 连接点（`.flow-handle`）的几何，CSS 和连线两边共用这一份。
 *
 * 可见的圆是手柄的 `::before`，用 `translate` 从节点边框往外推；手柄元素本身留在
 * Vue Flow 默认的位置（圆心压在边框上）不动。这样 Vue Flow 量出来的 `handleBounds`
 * 与缩放无关、不用重量，缩放时只有合成层上的 transform 和连线的 path 在变 —— 不触发布局。
 * 代价是连线端点要自己补上同样的偏移（`FlowEdge.vue` / `FlowConnectionLine.vue`）。
 */

/** 圆的内沿离节点边框的距离，单位是**屏幕像素**：连接点是界面不是内容，不跟着缩放 */
export const FLOW_HANDLE_GAP = 10

/** 圆的半径（直径见 vue-flow.css 的 `.flow-handle`） */
export const FLOW_HANDLE_RADIUS = 4

/**
 * 当前缩放下，圆要从手柄原位往外推多少（画布坐标）。
 *
 * 手柄原位的外沿在「边框 + 半径」，圆被推出去后外沿在「边框 + 直径 + 间距」，
 * 两者之差也是这个数 —— 所以圆的位移和连线端点的补偿是同一个值。
 */
export function flowHandleShift(zoom: number): number {
  return FLOW_HANDLE_RADIUS + FLOW_HANDLE_GAP / (zoom || 1)
}

/** 把连线端点沿手柄朝向往外挪 `distance` */
export function shiftOutward(x: number, y: number, position: Position, distance: number) {
  switch (position) {
    case Position.Left:
      return { x: x - distance, y }
    case Position.Right:
      return { x: x + distance, y }
    case Position.Top:
      return { x, y: y - distance }
    case Position.Bottom:
      return { x, y: y + distance }
  }
}
