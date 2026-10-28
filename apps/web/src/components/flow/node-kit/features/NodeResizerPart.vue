<script setup lang="ts">
import { NodeResizer } from "@vue-flow/node-resizer"

import { useNodePart } from "../context"

/**
 * 拉伸手柄（能力 `resizable`，挂在 `overlay` 区）。
 *
 * 手柄由官方 NodeResizer 提供 —— 它自己处理缩放下的坐标换算，手写 absolute + transform
 * 在缩放时必歪（见 CLAUDE.md 的画布约定）。只在选中时出现，否则画布上每个可拉伸的节点都挂着八个点。
 * （节点整块是 pointer-events-none 时，手柄要把事件要回来，规则在 apps/web/src/styles/vue-flow.css。）
 */
const ctx = useNodePart()

/** 最小尺寸：再小就装不下一个节点（眼下唯一的使用者是分组） */
const MIN_SIZE = { width: 160, height: 120 }

/**
 * 拉伸结束才写进文档。
 *
 * 拉伸过程中每一帧都会触发，中间态和拖动位置一样不该进 Y.Doc ——
 * 一次拉伸会变成几十条更新，而且每一条都会广播出去。
 */
function onResizeEnd(event: { params: { x: number; y: number; width: number; height: number } }) {
  const { x, y, width, height } = event.params
  const { store } = ctx.editor
  store.separateUndo()
  store.resizeNode(ctx.id, { width, height, x, y }, "调整大小")
  store.separateUndo()
}
</script>

<template>
  <NodeResizer
    :is-visible="ctx.selected.value"
    :min-width="MIN_SIZE.width"
    :min-height="MIN_SIZE.height"
    @resize-end="onResizeEnd"
  />
</template>
