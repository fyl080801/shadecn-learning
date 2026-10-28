<script setup lang="ts">
import { computed } from "vue"
import { getBezierPath, useVueFlow, type ConnectionLineProps } from "@vue-flow/core"

import { flowHandleShift, shiftOutward } from "@/components/flow/flow-handle"

/**
 * 拉线过程中的那条线，和 `FlowEdge.vue` 同一个道理：起点补上连接点的位移。
 * 终点平时跟着光标，只有吸附到某个连接点上时（`targetHandle` 非空）才一并补。
 */
const props = defineProps<ConnectionLineProps>()

const { viewport } = useVueFlow()

const path = computed(() => {
  const shift = flowHandleShift(viewport.value.zoom)
  const source = shiftOutward(props.sourceX, props.sourceY, props.sourcePosition, shift)
  const target = props.targetHandle
    ? shiftOutward(props.targetX, props.targetY, props.targetPosition, shift)
    : { x: props.targetX, y: props.targetY }
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
</script>

<template>
  <path class="vue-flow__connection-path" :d="path" fill="none" />
</template>
