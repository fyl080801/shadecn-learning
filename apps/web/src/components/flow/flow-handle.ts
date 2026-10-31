import { Position } from "@vue-flow/core"

import { screenToCanvas } from "@/components/flow/flow-screen"

/**
 * 连接点（`.flow-handle`）的几何，CSS 和连线两边共用这一份。
 *
 * 连接点是界面不是内容：圆的大小、离边框的距离、加号、感应区都按**屏幕像素**定，不随缩放变
 * （换算在 `flow-screen.ts`）。
 *
 * 可见的圆是手柄的 `::before`（加号是 `::after`），用 `translate` 从节点边框往外推、再按缩放倒数缩回屏幕尺寸；
 * 手柄元素本身留在 Vue Flow 默认的位置（`FLOW_HANDLE_BOX` 画布像素见方，圆心压在边框上）不动。
 * 这样 Vue Flow 量出来的 `handleBounds` 与缩放无关、不用重量，缩放时只有 transform 和连线的 path 在变 —— 不触发布局。
 * 代价是连线端点要自己补上偏移（`FlowEdge.vue` / `FlowConnectionLine.vue`，`flowHandleShift`）。
 */

/** 手柄元素的边长，**画布像素**（vue-flow.css 的 `.flow-handle` 宽高） */
export const FLOW_HANDLE_BOX = 8

/** 圆的内沿离节点边框的距离，屏幕像素 */
export const FLOW_HANDLE_GAP = 10

/** 圆的半径，屏幕像素（伪元素按 16px 画、平时缩到 0.625 —— 改这里要同步 vue-flow.css 的 `--flow-handle-scale`） */
export const FLOW_HANDLE_RADIUS = 5

/** 加号放大后的半径，屏幕像素 */
export const FLOW_HANDLE_PLUS_RADIUS = 8

/** 出口加号的感应区边长（从节点右边框往外、上下以手柄为中心），屏幕像素：鼠标在这块方区里，加号就跟着它走 */
export const FLOW_HANDLE_ZONE = 48

/** 圆心离手柄中心（= 节点边框）多远，画布坐标：CSS 的 `--flow-handle-offset` */
export function flowHandleOffset(zoom: number): number {
  return screenToCanvas(FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS, zoom)
}

/**
 * 连线端点要从 Vue Flow 给的位置往外挪多少，画布坐标。
 *
 * Vue Flow 给的端点是手柄元素的外沿（边框 + 半个手柄盒子），线头要接在圆的外沿（边框 + 间距 + 直径）。
 * 放得很大时可能是负数（圆比手柄盒子还贴边），照算即可。
 */
export function flowHandleShift(zoom: number): number {
  return screenToCanvas(FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS * 2, zoom) - FLOW_HANDLE_BOX / 2
}

/** 感应区边长（屏幕像素），至少容得下加号停在默认位置 */
const ZONE_SCREEN = Math.max(FLOW_HANDLE_ZONE, FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS + FLOW_HANDLE_PLUS_RADIUS * 2)

/** 感应区的尺寸（画布坐标）：正方形，屏幕上的大小不随缩放变 */
export function flowHandleZone(zoom: number) {
  const size = screenToCanvas(ZONE_SCREEN, zoom)
  return { width: size, height: size }
}

/**
 * 加号跟随鼠标时的圆心位置（画布坐标，相对手柄中心）。
 *
 * `dx` / `dy` 是鼠标离手柄中心的**屏幕**距离。圆心就落在鼠标下，但夹在感应区里（按屏幕像素夹，再折回画布坐标）：
 * 横向不比默认位置更靠近节点，纵向不超出以手柄为中心的同样范围。
 */
export function flowHandleFollow(dx: number, dy: number, zoom: number) {
  const minX = FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS
  const maxX = Math.max(minX, ZONE_SCREEN - FLOW_HANDLE_PLUS_RADIUS)
  const maxY = Math.max(0, ZONE_SCREEN / 2 - FLOW_HANDLE_PLUS_RADIUS)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return { x: screenToCanvas(clamp(dx, minX, maxX), zoom), y: screenToCanvas(clamp(dy, -maxY, maxY), zoom) }
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
