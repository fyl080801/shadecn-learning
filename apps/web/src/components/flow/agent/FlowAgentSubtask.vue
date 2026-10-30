<script setup lang="ts">
import { computed } from "vue"
import { ChevronRight, CircleAlert, CircleCheck, CircleQuestionMark } from "@lucide/vue"
import { useNow } from "@vueuse/core"
import type { AgentSubtaskView } from "@shadecn/shared/agent"
import { Spinner } from "@/components/ui/spinner"
import { formatDuration } from "@/lib/format"
import FlowAgentError from "./FlowAgentError.vue"
import FlowAgentMarkdown from "./FlowAgentMarkdown.vue"
import FlowAgentMention from "./FlowAgentMention.vue"

/**
 * 会话里的一个任务条目（docs/20 §3.10.11）：调用方的一次 `delegate_task`，替换掉那条普通的工具调用行。
 *
 * 折叠时：状态图标、任务说明、状态（进行中 / 完成 / 失败 / 需要确认）和已运行时长；点开看它要处理的节点、
 * 被调用的 agent 的工具调用、需要确认的问题 / 失败原因和它的最终回复（Markdown，只读）。没有单独的子会话，也不能在这里对它说话。
 * 已运行时长：在跑时每秒走一次（开始时刻是服务端打的，和本机时钟差出来的负数按 0 算），结束后固定为结束 − 开始。
 */
const props = defineProps<{ task: AgentSubtaskView }>()

const now = useNow({ interval: 1000 })

const STATUS_LABEL: Record<AgentSubtaskView["status"], string> = {
  running: "进行中",
  done: "完成",
  failed: "失败",
  needs_confirmation: "需要确认"
}

const elapsed = computed(() =>
  formatDuration((props.task.finishedAt ?? now.value.getTime()) - props.task.startedAt)
)

const hasDetails = computed(
  () =>
    props.task.nodeIds.length > 0 ||
    props.task.toolCalls.length > 0 ||
    Boolean(props.task.text) ||
    Boolean(props.task.question) ||
    Boolean(props.task.error)
)
</script>

<template>
  <details
    class="group rounded-md border bg-muted/40 text-xs"
    data-role="subtask"
    :data-subtask-id="props.task.id"
    :data-subtask-status="props.task.status"
  >
    <summary
      class="flex cursor-pointer list-none items-start gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden"
      :aria-label="`子任务：${props.task.brief}（${STATUS_LABEL[props.task.status]}）`"
    >
      <Spinner v-if="props.task.status === 'running'" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <CircleCheck v-else-if="props.task.status === 'done'" class="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
      <CircleQuestionMark
        v-else-if="props.task.status === 'needs_confirmation'"
        class="mt-0.5 size-3.5 shrink-0 text-amber-600"
      />
      <CircleAlert v-else class="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span class="min-w-0 flex-1">
        <span class="line-clamp-2 break-words" data-role="subtask-brief">{{ props.task.brief }}</span>
        <span class="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span data-role="subtask-status">子任务 · {{ STATUS_LABEL[props.task.status] }}</span>
          <span data-role="subtask-elapsed">已运行 {{ elapsed }}</span>
        </span>
      </span>
      <ChevronRight
        v-if="hasDetails"
        class="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
      />
    </summary>

    <div v-if="hasDetails" class="space-y-2 border-t px-2 py-2" data-role="subtask-details">
      <div v-if="props.task.nodeIds.length > 0" class="flex flex-wrap items-center gap-1">
        <span class="text-muted-foreground">节点</span>
        <FlowAgentMention v-for="nodeId in props.task.nodeIds" :key="nodeId" :node-id="nodeId" />
      </div>

      <ul v-if="props.task.toolCalls.length > 0" class="space-y-1 border-l pl-2" data-role="subtask-tools">
        <li
          v-for="call in props.task.toolCalls"
          :key="call.id"
          class="flex items-start gap-1.5"
          :data-tool-status="call.status"
        >
          <Spinner v-if="call.status === 'running'" class="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <CircleCheck v-else-if="call.status === 'done'" class="mt-0.5 size-3 shrink-0 text-emerald-600" />
          <CircleAlert v-else class="mt-0.5 size-3 shrink-0 text-destructive" />
          <span class="min-w-0 flex-1 break-words">
            {{ call.summary || call.name }}
            <span v-if="call.status === 'error' && call.error" class="block text-destructive">{{ call.error }}</span>
          </span>
        </li>
      </ul>

      <p v-if="props.task.question" class="flex items-start gap-1.5 text-amber-700 dark:text-amber-500" data-role="subtask-question">
        <CircleQuestionMark class="mt-0.5 size-3 shrink-0" />
        <span class="break-words">{{ props.task.question }}</span>
      </p>
      <div v-if="props.task.error" class="flex items-start gap-1.5 text-destructive" data-role="subtask-error">
        <CircleAlert class="mt-0.5 size-3 shrink-0" />
        <FlowAgentError :text="props.task.error" />
      </div>

      <div v-if="props.task.text" class="text-sm" data-role="subtask-reply">
        <FlowAgentMarkdown :text="props.task.text" />
      </div>

      <div v-if="props.task.changedNodeIds.length > 0" class="flex flex-wrap items-center gap-1">
        <span class="text-muted-foreground">改过</span>
        <FlowAgentMention v-for="nodeId in props.task.changedNodeIds" :key="nodeId" :node-id="nodeId" />
      </div>
    </div>
  </details>
</template>
