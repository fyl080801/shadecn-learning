<script setup lang="ts">
import { computed } from "vue"
import { useVueFlow } from "@vue-flow/core"

import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 拖动时的对齐辅助线。
 *
 * 和 `FlowPresenceCursors` 一样**必须放在 `<VueFlow>` 的 `#zoom-pane` 插槽里** ——
 * 那层是 `.vue-flow__transformationpane`，缩放平移的变换由 Vue Flow 自己维护，
 * 所以 SVG 里直接写画布坐标就行，不用自己算视口。
 *
 * 只有线宽要反向缩放：线是「界面」不是「内容」，缩到 0.2 倍时不该细得看不见。
 */
const { canvas } = useFlowEditor()
const { viewport } = useVueFlow()

const counterScale = computed(() => 1 / (viewport.value.zoom || 1))

/** 虚线的疏密也要反向缩放，否则缩小后一整条线糊成一根实线 */
const dashArray = computed(() => `${4 * counterScale.value} ${3 * counterScale.value}`)

/**
 * 固定用这个洋红，不跟主题走。
 *
 * 辅助线是转瞬即逝的操作反馈，要的是「在任何背景上都一眼看见」，
 * 用主题色反而会和节点、网格糊在一起 —— 设计工具清一色是这个做法。
 */
const GUIDE_COLOR = "#f43f5e"
</script>

<template>
  <svg
    v-if="canvas.snapping.guides.value.length > 0"
    class="pointer-events-none absolute left-0 top-0 overflow-visible"
    :style="{ zIndex: 9998 }"
    width="1"
    height="1"
  >
    <line
      v-for="(guide, index) in canvas.snapping.guides.value"
      :key="`${guide.orientation}-${index}`"
      :x1="guide.orientation === 'vertical' ? guide.position : guide.start"
      :y1="guide.orientation === 'vertical' ? guide.start : guide.position"
      :x2="guide.orientation === 'vertical' ? guide.position : guide.end"
      :y2="guide.orientation === 'vertical' ? guide.end : guide.position"
      :stroke="GUIDE_COLOR"
      :stroke-width="counterScale"
      :stroke-dasharray="dashArray"
    />
  </svg>
</template>
