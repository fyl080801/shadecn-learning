<script setup lang="ts">
import { useNodePart } from "../context"
import { useNodeOutputs } from "./outputs"

/**
 * 产出的大图预览（能力 `output-preview`，框外右侧的 `side` 区）。只在有人要求时露出 ——
 * 工具条上的「展开预览」；平时收着，几十个节点不挂几十张大图。用原图，不用封面。
 */
const ctx = useNodePart()
const { images } = useNodeOutputs(ctx, false)
</script>

<template>
  <div class="flex w-[480px] flex-col gap-2" data-testid="output-side-preview">
    <figure v-for="row in images" :key="row.port.id" class="space-y-1">
      <img
        :src="row.src ?? undefined"
        :alt="row.port.label ?? row.port.id"
        class="max-h-[480px] w-full rounded-md bg-muted object-contain"
        draggable="false"
      />
      <figcaption class="text-xs text-muted-foreground">{{ row.port.label ?? row.port.id }}</figcaption>
    </figure>
  </div>
</template>
