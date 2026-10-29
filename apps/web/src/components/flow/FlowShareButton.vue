<script setup lang="ts">
import { Share2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"

/**
 * 右上角的分享按钮 —— **占位，暂时没有任何动作**。
 *
 * 样式和旁边的对话按钮一致（浅色圆钮）。真要做分享时在这里接上即可，
 * 位置由 `FlowAgentChat` 的 `actions` 插槽决定（同一个右上角 Panel，排在对话按钮左边）。
 */
</script>

<template>
  <Button
    variant="outline"
    size="icon"
    class="size-10 rounded-full bg-card/95 shadow-lg backdrop-blur"
    title="分享"
    aria-label="分享"
    data-testid="flow-share"
  >
    <Share2 class="size-5" />
  </Button>
</template>
