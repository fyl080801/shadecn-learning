<script setup lang="ts">
import { computed } from "vue"
import { Bot, CircleQuestionMark } from "@lucide/vue"
import { useNow } from "@vueuse/core"
import { isAgentRunToolName, type AgentSubtaskView, type AgentToolCallView } from "@shadecn/shared/agent"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle
} from "@/components/ui/trace"
import { formatDuration } from "@/lib/format"
import FlowAgentError from "./FlowAgentError.vue"
import FlowAgentMarkdown from "./FlowAgentMarkdown.vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import FlowAgentToolCall from "./FlowAgentToolCall.vue"

/**
 * 会话里的一个任务条目（docs/20 §3.10.11、docs/26）：调用方的一次 `run_agent`（旧会话里是 `delegate_task`），替换掉那条普通的工具调用行。
 * 画法是 shadcn ai-elements 的 Subagent（`trace` 嵌一层 `trace`）。
 *
 * 折叠时一行：状态（进行中 = shimmer、失败 = 红、需要确认 = 琥珀）、任务说明、执行它的 agent（定义名，旧条目按 canvas）、已运行时长；
 * 展开看它要处理的节点、被调用的 agent 的工具调用（同一个 {@link FlowAgentToolCall}，能再展开看参数 / 结果）、
 * 需要确认的问题（ai-elements Confirmation 的 `Item` 样子 —— 只读：回答它就是在对话里再发一条消息）/ 失败原因、它的最终回复（Markdown）和改过的节点。
 * 被调用的 agent 自己再发起的任务（`tasks` 里 `parentId` 是这一项的）嵌在它的工具调用里，替换掉那条 run_agent —— 这个组件递归画它。
 * 没有单独的子会话，也不能在这里对它说话。
 * 已运行时长：在跑时每秒走一次（开始时刻是服务端打的，和本机时钟差出来的负数按 0 算），结束后固定为结束 − 开始。
 * 收起时内容也挂着（`unmount-on-hide=false`）：嵌套条目的状态、时长照样在走。
 */
const props = defineProps<{
  task: AgentSubtaskView
  /** 同一条消息的全部任务条目（平铺）：从里面找这一项发起的下层任务；不给 = 没有嵌套 */
  tasks?: readonly AgentSubtaskView[]
}>()

const now = useNow({ interval: 1000 })

const STATUS_LABEL: Record<AgentSubtaskView["status"], string> = {
  running: "进行中",
  done: "完成",
  failed: "失败",
  needs_confirmation: "需要确认"
}

const lineStatus = computed(() =>
  props.task.status === "running" ? "running" : props.task.status === "failed" ? "error" : undefined
)

const elapsed = computed(() =>
  formatDuration((props.task.finishedAt ?? now.value.getTime()) - props.task.startedAt)
)

/** 这一项发起的下层任务，按它那次 run_agent 的 id 认 */
const children = computed(() => (props.tasks ?? []).filter((item) => item.parentId === props.task.id))

const childByCall = computed(() => new Map(children.value.map((item) => [item.toolCallId, item])))

const childOf = (call: AgentToolCallView) => (isAgentRunToolName(call.name) ? childByCall.value.get(call.id) : undefined)

/** 对不上它任何一条工具调用的下层任务（不该有，容错）：排在工具调用之后 */
const looseChildren = computed(() => {
  const ids = new Set(props.task.toolCalls.map((call) => call.id))
  return children.value.filter((item) => !ids.has(item.toolCallId))
})
</script>

<template>
  <TraceCollapsible
    :unmount-on-hide="false"
    data-role="subtask"
    :data-subtask-id="props.task.id"
    :data-subtask-status="props.task.status"
  >
    <TraceCollapsibleTrigger
      class="max-w-full"
      :aria-label="`任务（${props.task.agent}）：${props.task.brief}（${STATUS_LABEL[props.task.status]}）`"
    >
      <TraceLine
        :status="lineStatus"
        :class="props.task.status === 'needs_confirmation' ? 'text-amber-700 dark:text-amber-500' : undefined"
      >
        <TraceIcon>
          <CircleQuestionMark v-if="props.task.status === 'needs_confirmation'" />
          <Bot v-else />
        </TraceIcon>
        <TraceTitle data-role="subtask-brief">{{ props.task.brief }}</TraceTitle>
        <TraceDescription class="flex items-center gap-1.5 text-[11px]">
          <Badge as="span" variant="outline" class="h-4 px-1 py-0 font-mono text-[10px] font-normal" data-role="subtask-agent">
            {{ props.task.agent }}
          </Badge>
          <span data-role="subtask-status">任务 · {{ STATUS_LABEL[props.task.status] }}</span>
          <span data-role="subtask-elapsed">已运行 {{ elapsed }}</span>
        </TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>

    <TraceCollapsibleContent class="flex flex-col gap-3 text-xs" data-role="subtask-details">
      <div v-if="props.task.nodeIds.length > 0" class="flex flex-wrap items-center gap-1">
        <span>节点</span>
        <FlowAgentMention v-for="nodeId in props.task.nodeIds" :key="nodeId" :node-id="nodeId" />
      </div>

      <Trace
        v-if="props.task.toolCalls.length > 0 || looseChildren.length > 0"
        data-role="subtask-tools"
      >
        <template v-for="call in props.task.toolCalls" :key="call.id">
          <FlowAgentSubtask v-if="childOf(call)" :task="childOf(call)!" :tasks="props.tasks" />
          <FlowAgentToolCall v-else :call="call" />
        </template>
        <FlowAgentSubtask v-for="child in looseChildren" :key="child.id" :task="child" :tasks="props.tasks" />
      </Trace>
      <p v-else-if="props.task.status === 'running'" class="shimmer text-muted-foreground motion-reduce:shimmer-none">准备中…</p>

      <Item
        v-if="props.task.question"
        variant="outline"
        size="sm"
        class="border-amber-500/40 bg-amber-500/5"
        data-role="subtask-confirmation"
      >
        <ItemMedia variant="icon" class="text-amber-600">
          <CircleQuestionMark />
        </ItemMedia>
        <ItemContent>
          <ItemTitle class="text-xs">需要你确认</ItemTitle>
          <ItemDescription class="line-clamp-none text-xs whitespace-pre-wrap" data-role="subtask-question">{{ props.task.question }}</ItemDescription>
        </ItemContent>
      </Item>
      <div v-if="props.task.error" class="text-destructive" data-role="subtask-error">
        <FlowAgentError :text="props.task.error" />
      </div>

      <div v-if="props.task.text" class="text-sm text-foreground" data-role="subtask-reply">
        <FlowAgentMarkdown :text="props.task.text" />
      </div>

      <div v-if="props.task.changedNodeIds.length > 0" class="flex flex-wrap items-center gap-1">
        <span>改过</span>
        <FlowAgentMention v-for="nodeId in props.task.changedNodeIds" :key="nodeId" :node-id="nodeId" />
      </div>
    </TraceCollapsibleContent>
  </TraceCollapsible>
</template>
