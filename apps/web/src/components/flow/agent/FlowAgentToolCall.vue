<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, Wrench } from "@lucide/vue"
import type { AgentToolCallView } from "@shadecn/shared/agent"
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle
} from "@/components/ui/trace"
import FlowAgentError from "./FlowAgentError.vue"
import FlowAgentToolDetail from "./FlowAgentToolDetail.vue"

/**
 * 一条工具调用 —— shadcn ai-elements 的 Tool 写法（`trace` + `code-block`）。
 *
 * 一行：图标 + 给人看的那句话（`summary`）+ 工具名。运行中标题带 shimmer，出错整行变红。
 * 有参数 / 结果 / 出错原因时可以展开：参数、结果各一块代码（{@link FlowAgentToolDetail}），出错原因按模型报错的拆法显示。
 * 这几个字段出现之前存的记录只有那句话 —— 那就只画一行，不能展开。
 */
const props = defineProps<{
  call: AgentToolCallView
}>()

const status = computed(() =>
  props.call.status === "running" ? "running" : props.call.status === "error" ? "error" : undefined
)

const hasDetails = computed(() => Boolean(props.call.input || props.call.output || (props.call.status === "error" && props.call.error)))
</script>

<template>
  <TraceCollapsible v-if="hasDetails" data-role="tool-call" :data-tool-status="props.call.status" :data-tool-name="props.call.name">
    <TraceCollapsibleTrigger>
      <TraceLine :status="status">
        <TraceIcon>
          <CircleAlert v-if="props.call.status === 'error'" />
          <Wrench v-else />
        </TraceIcon>
        <TraceTitle>{{ props.call.summary || props.call.name }}</TraceTitle>
        <TraceDescription class="font-mono text-[10px]">{{ props.call.name }}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent class="flex flex-col gap-2">
      <FlowAgentToolDetail v-if="props.call.input" title="参数" :text="props.call.input" />
      <FlowAgentToolDetail v-if="props.call.output" title="结果" :text="props.call.output" />
      <div
        v-if="props.call.status === 'error' && props.call.error"
        class="text-xs text-destructive"
        data-role="tool-error"
      >
        <FlowAgentError :text="props.call.error" />
      </div>
    </TraceCollapsibleContent>
  </TraceCollapsible>
  <TraceLine v-else :status="status" data-role="tool-call" :data-tool-status="props.call.status" :data-tool-name="props.call.name">
    <TraceIcon>
      <CircleAlert v-if="props.call.status === 'error'" />
      <Wrench v-else />
    </TraceIcon>
    <TraceTitle>{{ props.call.summary || props.call.name }}</TraceTitle>
    <TraceDescription class="font-mono text-[10px]">{{ props.call.name }}</TraceDescription>
  </TraceLine>
</template>
