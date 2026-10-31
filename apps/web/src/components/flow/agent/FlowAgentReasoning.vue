<script setup lang="ts">
import { computed, ref } from "vue"
import { Brain } from "@lucide/vue"
import type { AgentReasoningView } from "@shadecn/shared/agent"
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle
} from "@/components/ui/trace"
import { formatDuration } from "@/lib/format"

/**
 * 入口 agent 的一段思考（模型的 thinking 块）—— shadcn ai-elements 的 Reasoning 写法（`trace`）。
 *
 * - 想着的时候：标题「思考中」带 shimmer，**自动展开**、跟着流式往下长；想完自动收起，标题换成「思考了 N 秒」。
 * - 人手动开 / 合过之后以人的为准（不再跟着自动开合）。
 * - 还没出字（只收到开头一帧）时只画一行，没有可展开的内容。
 * - 时长 = 服务端打的开始 / 结束时刻之差（同一台机器的钟，不跨端比较）。
 */
const props = defineProps<{
  reasoning: AgentReasoningView
}>()

const running = computed(() => props.reasoning.finishedAt === undefined)

/** 人手动开合过的状态；null = 跟着自动走 */
const manual = ref<boolean | null>(null)
const open = computed({
  get: () => manual.value ?? running.value,
  set: (value: boolean) => {
    manual.value = value
  }
})

const duration = computed(() => {
  if (props.reasoning.finishedAt === undefined) return null
  const ms = props.reasoning.finishedAt - props.reasoning.startedAt
  return ms < 1000 ? "不到 1 秒" : formatDuration(ms)
})
</script>

<template>
  <TraceCollapsible
    v-if="props.reasoning.text"
    v-model:open="open"
    data-role="reasoning"
    :data-reasoning-status="running ? 'running' : 'done'"
  >
    <TraceCollapsibleTrigger>
      <TraceLine :status="running ? 'running' : undefined">
        <TraceIcon><Brain /></TraceIcon>
        <TraceTitle>{{ running ? "思考中" : "思考过程" }}</TraceTitle>
        <TraceDescription v-if="duration">{{ duration }}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent class="whitespace-pre-wrap text-xs" data-role="reasoning-text">
      {{ props.reasoning.text }}
    </TraceCollapsibleContent>
  </TraceCollapsible>
  <TraceLine v-else :status="running ? 'running' : undefined" data-role="reasoning" :data-reasoning-status="running ? 'running' : 'done'">
    <TraceIcon><Brain /></TraceIcon>
    <TraceTitle>{{ running ? "思考中" : "思考过程" }}</TraceTitle>
  </TraceLine>
</template>
