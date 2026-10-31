<script setup lang="ts">
import type { Component } from "vue"

import { Button } from "@/components/ui/button"
import { useNodePart } from "@/components/flow/node-kit/context"
import type { NodeEventName } from "@/components/flow/node-kit/protocol"

/**
 * 节点右上角（`badge` 区）「弹出编辑」的图标按钮 —— 所有弹出编辑同款（`popupOpenPart` 包一层后登记），
 * 和图片 / 视频的上传按钮（`NodeUploadButton.vue`）同款、同位置。
 *
 * 点了只发事件（发出方就是这个节点），由编辑器级的 `FlowNodePopupHost.vue` 接住、盖一层 backdrop 弹出来；
 * 这里不跳路由、不弹层，也不写文档。
 *
 * 只在指针悬停到节点上时出现（`flow-node-hover-reveal`，见 vue-flow.css；触屏一直显示）。
 * 角标区整块 `pointer-events-none`（不挡拖节点），按钮自己要 `pointer-events-auto` 拿回点击。
 * `nodrag nopan`：在按钮上按下不该变成拖节点 / 拖画布；`@dblclick.stop` 免得双击按钮被当成双击节点。
 */
const props = defineProps<{
  event: NodeEventName
  payload: unknown
  title: string
  icon: Component
  testId: string
}>()

const ctx = useNodePart()

function open() {
  ;(ctx.emit as (event: NodeEventName, payload: unknown) => void)(props.event, props.payload)
}
</script>

<template>
  <Button
    variant="secondary"
    size="icon"
    class="flow-node-hover-reveal nodrag nopan pointer-events-auto size-7 rounded-full shadow-sm"
    :title="title"
    :aria-label="title"
    :data-testid="testId"
    @click.stop="open()"
    @dblclick.stop
  >
    <component :is="icon" class="size-3.5" />
  </Button>
</template>
