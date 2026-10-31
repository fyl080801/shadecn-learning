/**
 * 画布上「界面」元素按**屏幕像素**画，不跟着缩放变 —— 公共的那一份换算。
 *
 * 节点和连线在 Vue Flow 的 `.vue-flow__transformationpane` 里，整层被 `scale(zoom)`。
 * 节点的内容（图片、文字）就该跟着缩放；但连接点、加号和它的感应区、连线粗细、
 * 节点的边框 / 选中描边 / 阴影、角标区的按钮、空占位这些是**界面**，放大缩小都应该一样粗、一样大。
 *
 * `FlowCanvas.vue` 把 `flowScreenVars(zoom)` 写在画布根上，下面所有元素继承两个变量：
 * `--flow-zoom-inv`（缩放倒数，无单位）和 `--flow-px`（一个屏幕像素的画布长度，带 `px`）。
 *
 * ## 新元素只声明「要哪种特性」，不碰换算
 *
 * | 特性 | 怎么声明 |
 * |---|---|
 * | 节点部件整块保持屏幕尺寸 | 登记到 `badge` 区（宿主自动处理，部件什么都不用写） |
 * | 任意元素整块保持屏幕尺寸 | `class="flow-screen-fixed"`，原点用 `origin-*`（如 `origin-top-right`）；里面的尺寸 / 内边距 / 字号都是屏幕像素 |
 * | 节点边框 / 选中描边 / 阴影 | 宿主的 `.flow-node` 自带；状态换样子写语义类（`flow-node-selected` / `-processing` / `-error`），颜色走 `--flow-node-*-color` 变量 |
 * | 连线粗细、热区 | 用 Vue Flow 的 `.vue-flow__edge-path` 画就自动有 |
 * | 单个长度（CSS） | `calc(N * var(--flow-px, 1px))` |
 * | 和节点在屏幕上等宽（框外元素） | 写 `--flow-node-width`（画布宽度，无单位），CSS `calc(var(--flow-node-width) * 1px / var(--flow-zoom-inv, 1))`（名字行 `.flow-node-label-row`） |
 * | 单个长度（TS / SVG 属性） | `screenToCanvas(N, zoom)` |
 *
 * 这些都只改 transform / 阴影 / 描边，不改盒子尺寸：Vue Flow 量好的节点尺寸、连接点位置不会失效。
 * 别在组件里另写 `1 / zoom`；这些值每个缩放帧都在变，**别给它们加 `transition`**，否则缩放时拖影。
 */

/** 一段屏幕像素长度，在当前缩放下折成画布坐标 */
export function screenToCanvas(px: number, zoom: number): number {
  return px / (zoom || 1)
}

/** 写在画布根上的 CSS 变量（见文件头） */
export function flowScreenVars(zoom: number): Record<string, string> {
  const inv = screenToCanvas(1, zoom)
  return {
    "--flow-zoom-inv": String(inv),
    "--flow-px": `${inv}px`
  }
}
