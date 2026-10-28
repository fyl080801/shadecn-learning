<script setup lang="ts">
import { useNodePart } from "../context"
import { previewText, useNodeOutputs } from "./outputs"

/** 各输出端口当前的产出（能力 `output-preview`，footer 区）：图片画缩略图，其余给一行文本预览 */
const ctx = useNodePart()
const { rows } = useNodeOutputs(ctx)
</script>

<template>
  <div class="space-y-1 border-t pt-1.5 text-xs" data-testid="generic-node-outputs">
    <div v-for="row in rows" :key="row.port.id">
      <img
        v-if="row.src"
        :src="row.src"
        :alt="row.port.label ?? row.port.id"
        class="max-h-32 w-full rounded-sm bg-muted object-contain"
        loading="lazy"
        draggable="false"
      />
      <p v-else class="truncate">
        <span class="text-muted-foreground">{{ row.port.label ?? row.port.id }}：</span>
        {{ previewText(row.value) }}
      </p>
    </div>
  </div>
</template>
