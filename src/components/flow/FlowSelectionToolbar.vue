<script setup lang="ts">
import { computed } from "vue"
import { Position } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"
import { Group } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow"

/**
 * 选区工具栏 —— 框选出一片节点之后，浮在这片节点**上方**的那一条。
 *
 * 和节点自己头上那条（`FlowNodeChrome`）分工明确：那条上面的复制 / 删除是对
 * **单个**节点说的，所以恰好选中一个时才出现；这条上面放的是对**一片**说的动作
 * （目前是打组），所以选中两个及以上才出现。两者永远不会同时在屏幕上。
 *
 * 定位交给官方的 `NodeToolbar`：它的 `nodeId` 可以是一个 id 数组，
 * 会自己算这批节点的外接矩形并贴在它上边 —— 缩放平移下的跟随由它负责。
 * 自己拿 `screenToFlowCoordinate` 写一份 absolute 定位是不行的，缩放时必歪。
 */
const { canvas } = useFlowEditor()

/**
 * 框选一片才出现；恰好一个时让位给节点自己那条工具栏。
 *
 * **松开鼠标才出现**：框还在拉的时候，选中的是哪几个每一帧都在变，工具栏会跟着
 * 外接矩形一路乱跳，而这时也没人要点它。拉框期间的反馈是节点高亮逐个翻转，
 * 按钮等手停下来再给。
 */
const visible = computed(
  () => canvas.selectedNodeIds.value.length > 1 && !canvas.boxSelecting.value
)
</script>

<template>
  <NodeToolbar
    :node-id="canvas.selectedNodeIds.value"
    :is-visible="visible"
    :position="Position.Top"
    align="center"
    :offset="12"
  >
    <div
      class="nodrag nopan flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
    >
      <!--
        选中的节点里如果有已经在别的分组里的、或者分组框本身，它们不参与打组
        （见 useFlowCanvas.groupableNodes）—— 剩不下两个就没什么可圈的，按钮置灰。
      -->
      <Button
        variant="ghost"
        size="icon"
        class="size-8 rounded-full"
        :disabled="!canvas.canGroupSelection.value"
        title="打组（把选中的节点框在一起）"
        @click.stop="canvas.groupSelection()"
      >
        <Group />
      </Button>
    </div>
  </NodeToolbar>
</template>
