<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert } from "@lucide/vue"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useNodePart } from "../context"

/**
 * 出错时的提示（能力 status，overlay 区；只在 error 时挂上）：盖在节点主体上，居中一个「生成失败」，
 * **不占位、不撑开节点**（错误信息可能很长）；完整的 `runtime.error` 放在悬停提示里，没有文案时给兜底。
 *
 * 整层 `pointer-events-none`：节点照常能选中、拖动、双击、点角标（上传等）；只有中间那枚提示接悬停。
 */
const ctx = useNodePart()

const detail = computed(() => ctx.node.runtime.value.error || "运行出错")
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] bg-card/85 p-3 backdrop-blur-[2px]"
    data-testid="node-status-error"
  >
    <Tooltip>
      <TooltipTrigger as-child>
        <div
          class="pointer-events-auto flex max-w-full items-center gap-1.5 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm"
          tabindex="0"
          :aria-label="`生成失败：${detail}`"
        >
          <CircleAlert class="size-4 shrink-0" />
          <span class="truncate text-xs font-medium" data-role="title">生成失败</span>
        </div>
      </TooltipTrigger>
      <TooltipContent class="max-w-72 break-words" data-role="detail">{{ detail }}</TooltipContent>
    </Tooltip>
  </div>
</template>
