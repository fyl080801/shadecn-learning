<script setup lang="ts">
import { computed } from "vue"
import { getBezierPath, Position, useVueFlow } from "@vue-flow/core"

import { flowHandleShift, shiftOutward } from "@/components/flow/flow-handle"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 拉线到空白处松手、新建菜单（`FlowGrowMenu`）还开着时，留在画布上的那条线。
 *
 * Vue Flow 松手就收掉拉线中的线；这里接着画一条一样的（同一个 class、同样的虚线），起点是出口的连接点、终点是落点
 * （`growMenu.at`，新节点入口要落的位置）。选了一种节点就由真的边接上，关掉菜单它随之消失。
 *
 * 必须放在 `<VueFlow>` 的 `#zoom-pane` 插槽里：那层跟着缩放平移，SVG 里直接写画布坐标。
 */
const { canvas } = useFlowEditor()
const { findNode, viewport } = useVueFlow()

const path = computed(() => {
  const menu = canvas.growMenu.value
  if (!menu || menu.via !== "drop") return null
  const node = findNode(menu.sourceId)
  const handle = node?.handleBounds.source?.[0]
  if (!node || !handle) return null
  // 和 Vue Flow 给连线的端点同一个算法：右侧手柄的外沿中点，再补上连接点往外推的那段
  const source = shiftOutward(
    node.computedPosition.x + handle.x + handle.width,
    node.computedPosition.y + handle.y + handle.height / 2,
    Position.Right,
    flowHandleShift(viewport.value.zoom)
  )
  const [d] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: Position.Right,
    targetX: menu.at.x,
    targetY: menu.at.y,
    targetPosition: Position.Left
  })
  return d
})
</script>

<template>
  <svg
    v-if="path"
    class="pointer-events-none absolute left-0 top-0 overflow-visible"
    width="1"
    height="1"
    data-testid="flow-pending-connection"
  >
    <path class="vue-flow__connection-path" :d="path" fill="none" />
  </svg>
</template>
