<script setup lang="ts">
import { computed } from "vue"
import type { AgentUsageView } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { formatTokens, formatUsd } from "@/lib/format"

/**
 * 一轮的模型用量 —— shadcn ai-elements 的 Context 写法（`hover-card` + `progress`）。
 *
 * 按钮上是「上下文占了百分之几」：入口 agent 最后一次请求的输入 + 输出 / 模型窗口（下一轮带着的历史大约这么大）；
 * 悬停看明细：这一轮全部请求（含被调用的 agent）的输入 / 输出 / 缓存读写 token 和费用（没有价格信息显示「未知」）。
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

const rows = computed(() => [
  { label: "输入", value: formatTokens(props.usage.inputTokens) },
  { label: "输出", value: formatTokens(props.usage.outputTokens) },
  { label: "缓存读", value: formatTokens(props.usage.cacheReadTokens) },
  { label: "缓存写", value: formatTokens(props.usage.cacheWriteTokens) }
])
</script>

<template>
  <HoverCard :open-delay="10" :close-delay="100">
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        size="xs"
        class="h-5 px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums"
        :aria-label="`上下文已用 ${percent}%，这一轮费用 ${formatUsd(props.usage.costUsd)}`"
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
      <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-muted-foreground">{{ row.label }}</dt>
          <dd class="text-right tabular-nums">{{ row.value }}</dd>
        </template>
      </dl>
      <div class="flex items-center justify-between gap-2 border-t pt-2">
        <span class="min-w-0 truncate text-muted-foreground" :title="props.usage.model">{{ props.usage.model }}</span>
        <span class="tabular-nums" data-role="usage-cost">{{ formatUsd(props.usage.costUsd) }}</span>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>
