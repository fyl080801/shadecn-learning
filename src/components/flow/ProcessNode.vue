<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core"

export interface ProcessNodeData {
  label: string
}

defineProps<NodeProps<ProcessNodeData>>()
</script>

<template>
  <div
    class="relative min-w-32 rounded-md border bg-card px-4 py-2 text-center text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
  >
    <Handle
      type="target"
      :position="Position.Left"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />

    {{ data.label }}

    <Handle
      type="source"
      :position="Position.Right"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />
  </div>
</template>
