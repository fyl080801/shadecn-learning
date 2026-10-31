<script setup lang="ts">
import { computed } from "vue"
import type { AgentUsageView } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { formatTokens } from "@/lib/format"

/**
 * 一轮的模型用量 —— shadcn ai-elements 的 Context 写法（`hover-card` + `progress`）。
 *
 * 按钮上是「上下文占了百分之几」：入口 agent 最后一次请求的输入 + 输出 / 模型窗口（下一轮带着的历史大约这么大）；
 * 悬停只看上下文：已用 / 窗口 token 和一条用量条；输入 / 输出 / 缓存 / 费用明细不显示（`AgentUsageView` 里照样有）。
 * 数是服务端收尾那一刻的（`AgentUsageView`），被叫停时还在途的那次请求不在里面。
 */
const props = defineProps<{
  usage: AgentUsageView
}>()

const percent = computed(() => {
  const { contextTokens, contextWindow } = props.usage
  if (!(contextWindow > 0)) return 0
  return Math.min(100, Math.round((contextTokens / contextWindow) * 100))
})
</script>

<template>
  <HoverCard :open-delay="10" :close-delay="100">
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        size="xs"
        class="h-5 px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums"
        :aria-label="`上下文已用 ${percent}%`"
        data-role="usage"
      >
        {{ percent }}% 上下文
      </Button>
    </HoverCardTrigger>
    <HoverCardContent class="flex w-64 flex-col gap-3 text-xs" align="start" data-role="usage-details">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">上下文</span>
        <span class="text-muted-foreground tabular-nums">
          {{ formatTokens(props.usage.contextTokens) }} / {{ formatTokens(props.usage.contextWindow) }}
        </span>
      </div>
      <Progress :model-value="percent" aria-label="上下文已用" class="h-1.5" />
    </HoverCardContent>
  </HoverCard>
</template>
