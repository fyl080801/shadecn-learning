<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core"

import FlowNodeChrome from "@/components/flow/FlowNodeChrome.vue"

export interface ProcessNodeData {
  label: string
}

const props = defineProps<NodeProps<ProcessNodeData>>()

/**
 * 流程节点 —— 一张空卡片，暂时只有名字。
 *
 * 名字标签和选中时的复制 / 删除工具栏都在 `FlowNodeChrome` 里（每种节点共用一份），
 * 这个文件只管「这种节点长什么样」。
 */
</script>

<template>
  <!--
    宽度固定 360，高度下限按 16:9 给到 202.5（= 360 × 9 / 16），内容更高就自然撑开。
    写成 `min-h` 而不是 `aspect-video`：aspect-ratio 只在高度自动、且内容装得下时才成立，
    内容一旦超出，块级盒子是溢出而不是长高 —— 那正好和「内容高就撑开」相反。
  -->
  <div
    class="relative min-h-[202.5px] w-[360px] rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
  >
    <FlowNodeChrome :node-id="props.id" :label="props.data.label" />

    <Handle
      type="target"
      :position="Position.Left"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />

    <Handle
      type="source"
      :position="Position.Right"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />
  </div>
</template>
