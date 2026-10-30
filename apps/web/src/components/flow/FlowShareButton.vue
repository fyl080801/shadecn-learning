<script setup lang="ts">
import { Share2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"

/**
 * 右上角的分享按钮 —— **占位，暂时没有任何动作**。
 *
 * 样式和旁边的对话按钮一致（浅色圆钮）。真要做分享时在这里接上即可，
 * 位置由 `FlowEditor.vue` 决定（右上角同一个 Panel，和对话按钮并列、排在它左边）。
 */
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        variant="outline"
        size="icon"
        class="size-10 rounded-full bg-card/95 shadow-lg backdrop-blur"
        aria-label="分享"
        data-testid="flow-share"
      >
        <Share2 class="size-5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">分享</TooltipContent>
  </Tooltip>
</template>
