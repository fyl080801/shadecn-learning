<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"

export interface ProcessNodeData {
  label: string
}

defineProps<NodeProps<ProcessNodeData>>()
</script>

<template>
  <div
    class="relative min-h-12 min-w-32 rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
  >
    <!--
      节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
      （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
      is-visible 常开，否则默认只在节点被选中时出现。
    -->
    <NodeToolbar :is-visible="true" :position="Position.Top" align="start" :offset="4">
      <span class="text-xs font-medium text-muted-foreground">{{ data.label }}</span>
    </NodeToolbar>

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
