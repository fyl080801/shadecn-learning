<script setup lang="ts">
import { computed } from "vue"
import { useKeyModifier } from "@vueuse/core"
import { useVueFlow, type Styles } from "@vue-flow/core"
import { NodeResizeControl, type OnResizeEnd } from "@vue-flow/node-resizer"

import { useNodeKitRuntime, useNodePart } from "../context"

/**
 * 拉伸手柄（能力 `resizable`，挂在 `overlay` 区）。
 *
 * **只有右下角一个手柄**：官方 `NodeResizeControl`（`position="bottom-right"`）—— 它自己处理缩放下的坐标换算，
 * 手写 absolute + transform 在缩放时必歪（见 flow-editor 的画布约定）。平时看不见，指针移到右下角才在框外浮出
 * 一段比节点大一圈的圆角外圈，整块按屏幕尺寸（样式在 `styles/vue-flow.css` 的 `.flow-resize-corner`）。
 * 不要求先选中：右下角本身就是入口；拉框时收起，免得扫过时冒出来。
 *
 * **`node-id` 必须显式传**：`NodeResizeControl` 不像 `NodeResizer` 那样自己从节点上下文注入 id，
 * 没有 id 它连拖动都不挂 —— 手柄看得见、hover 有弧线，就是拖不动。
 *
 * 约束来自类型外观的 `view.resize`：最小尺寸、是否锁定宽高比。自由拉伸的类型按住 Shift 临时锁比例。
 */
const ctx = useNodePart()
const { kit } = useNodeKitRuntime()
const { findNode } = useVueFlow()

/** 没写约束时的最小尺寸：再小就装不下一个节点 */
const DEFAULT_MIN = { width: 160, height: 120 }

const spec = computed(() => kit.viewOf(ctx.type).resize ?? {})

// 拖动中每一帧组件都会重新读这个 prop，所以按下 / 松开 Shift 当场生效
const shift = useKeyModifier("Shift", { initial: false })
const keepAspectRatio = computed(() => spec.value.keepAspectRatio === true || shift.value === true)

const visible = computed(() => !ctx.editor.canvas.boxSelecting.value)

/**
 * 拉伸结束才写进文档。
 *
 * 拉伸过程中每一帧都会触发，中间态和拖动位置一样不该进 Y.Doc ——
 * 一次拉伸会变成几十条更新，而且每一条都会广播出去。
 *
 * 写完要把 Vue Flow 在拉伸中塞进节点 `style` 的 width / height 摘掉：Vue Flow 的节点样式里 `style.width`
 * 优先于 `node.width`，留着的话尺寸就被钉死在本地这一份 —— 撤销、别人改尺寸都改不动画面
 * （分组以前用 `NodeResizer` 时就是这样：拉伸后撤销，文档回去了，框没回去）。
 * 尺寸只该有一个来源：文档里的 layout。
 */
function onResizeEnd(event: OnResizeEnd) {
  const { x, y, width, height } = event.params
  // 撤销分段、分组边界（框长回罩得住组员 / 不许长到组外节点上）都在 canvas.resizeNode 里
  ctx.editor.canvas.resizeNode(ctx.id, { width, height, x, y })

  // 摘空了就置 undefined，**不能留一个空对象**：Vue Flow 的节点样式计算拿到对象时会把 `node.width` 直接写进
  // 这个对象本身（它改的是同一个引用），空对象转眼又被填回 width / height，等于没摘
  const node = findNode(ctx.id)
  if (node && node.style && typeof node.style === "object") {
    const style: Styles = { ...node.style }
    delete style.width
    delete style.height
    node.style = Object.keys(style).length > 0 ? style : undefined
  }
}
</script>

<template>
  <NodeResizeControl
    v-if="visible"
    :node-id="ctx.id"
    position="bottom-right"
    class="flow-resize-corner"
    :auto-scale="false"
    :min-width="spec.minWidth ?? DEFAULT_MIN.width"
    :min-height="spec.minHeight ?? DEFAULT_MIN.height"
    :keep-aspect-ratio="keepAspectRatio"
    title="拖动调整大小（按住 Shift 保持比例）"
    data-testid="node-resize-corner"
    @resize-end="onResizeEnd"
  >
    <!-- 框外那一圈的右下角弧线：半径、间距、颜色都在 styles/vue-flow.css 的 .flow-resize-corner-arc -->
    <span class="flow-resize-corner-arc" aria-hidden="true" />
  </NodeResizeControl>
</template>
