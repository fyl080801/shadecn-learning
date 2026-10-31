<script setup lang="ts">
import { computed } from "vue"
import { BaseEdge, getBezierPath, useVueFlow, type EdgeProps } from "@vue-flow/core"

import { isEdgeHighlighted } from "@/components/flow/edge-highlight"
import { flowHandleShift, shiftOutward } from "@/components/flow/flow-handle"

/**
 * 画布的连线：就是 Vue Flow 默认的贝塞尔线，只把两端接到推出去的连接点上。
 *
 * Vue Flow 给的端点是手柄元素的外沿，而可见的圆被 `translate` 往外推了
 * （见 `flow-handle.ts`），这里按当前缩放补上同样的位移，线头才正好接在圆上。
 */
const props = defineProps<EdgeProps>()

const { viewport } = useVueFlow()

const path = computed(() => {
  const shift = flowHandleShift(viewport.value.zoom)
  const source = shiftOutward(props.sourceX, props.sourceY, props.sourcePosition, shift)
  const target = shiftOutward(props.targetX, props.targetY, props.targetPosition, shift)
  const [d] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: props.sourcePosition,
    targetX: target.x,
    targetY: target.y,
    targetPosition: props.targetPosition
  })
  return d
})

const highlighted = computed(() =>
  isEdgeHighlighted({ selected: props.selected ?? false, sourceNode: props.sourceNode, targetNode: props.targetNode })
)
</script>

<template>
  <BaseEdge
    :id="props.id"
    :path="path"
    :class="{ 'flow-edge-highlighted': highlighted }"
    :marker-start="props.markerStart"
    :marker-end="props.markerEnd"
    :style="props.style"
    :interaction-width="props.interactionWidth"
  />
</template>
