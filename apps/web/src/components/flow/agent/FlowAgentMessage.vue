<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, Eye, Puzzle } from "@lucide/vue"
import {
  agentAttachmentKind,
  isAgentRunToolName,
  type AgentChatMessage,
  type AgentReasoningView,
  type AgentSubtaskView,
  type AgentToolCallView
} from "@shadecn/shared/agent"
import AssetPreview from "@/components/flow/asset-upload/AssetPreview.vue"
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle
} from "@/components/ui/trace"
import FlowAgentError from "./FlowAgentError.vue"
import FlowAgentMarkdown from "./FlowAgentMarkdown.vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import FlowAgentReasoning from "./FlowAgentReasoning.vue"
import FlowAgentSubtask from "./FlowAgentSubtask.vue"
import FlowAgentToolCall from "./FlowAgentToolCall.vue"
import FlowAgentUsage from "./FlowAgentUsage.vue"
import { splitMentions } from "./nodeMention"

/**
 * 对话里的一条消息，按 shadcn ai-elements 的写法排（`message` + `bubble` + `trace`）。
 *
 * 用户消息：Bubble（靠右）里是文字 + 提及 badge（和输入框里同一个组件，名字现查，删了的节点灰掉）；带了附件时气泡上方一排缩略图
 * （docs/20 §3.10.12，`ui/attachment` 的小方块，预览和输入区里的附件同一个组件，地址是对象存储的；点开在新标签页里看原文件）。只有附件没写字时不画气泡。
 *
 * assistant 消息：先是一条**过程时间线**（`Trace`），再是流式的 Markdown 正文（docs/20 F16），然后是收尾原因和用量。
 * - 时间线 = 思考段（Reasoning，{@link FlowAgentReasoning}）、工具调用（Tool，{@link FlowAgentToolCall}）和**工具调用之间说的话**按发生的先后：
 *   思考段和每段文字（`textSegments`）都带着「出现在第几条工具调用之前」（`position`），据此插进工具调用之间（同一位置：先思考、再说话、再调工具 ——
 *   一次模型请求就是这个顺序）。最后一条工具调用之后的文字是正文，画在时间线下面；没有 `textSegments` 的旧记录整段当正文。
 * - 任务（docs/20 §3.10.11、docs/26）：入口 agent 的 `run_agent` 那一条画成可展开的任务条目（Subagent，{@link FlowAgentSubtask}，按 `toolCallId` 对上；
 *   旧会话里的工具名是 `delegate_task`，同样认，见 shared 的 `isAgentRunToolName`）；被调用的 agent 再发起的任务（`parentId`）嵌在父条目里。
 *   被拒、没发起成的 run_agent 没有条目，照常是一条出错的工具调用。
 * - 一轮以失败或中止收尾时在最后挂一行原因（模型报错按「状态码 + 上游错误体」拆开显示，见 `FlowAgentError`）。
 * - 用量（Context，{@link FlowAgentUsage}）：收尾时服务端写上的，在消息脚注里。
 *
 * 画布改动通知（docs/20 §3.10.2）：时间线样式的一行（图标 + 概括），有条目时可以展开看每一处。
 * 技能加载（docs/23 §3.6）：同样一行「已加载：<技能标题>」。
 */
const props = defineProps<{
  message: AgentChatMessage
  /** 这条是不是本轮正在流式拼出来的那条：什么都还没有时显示「思考中」 */
  streaming?: boolean
}>()

const segments = computed(() =>
  props.message.role === "user" ? splitMentions(props.message.text) : []
)

const attachments = computed(() =>
  props.message.role === "user" && Array.isArray(props.message.attachments) ? props.message.attachments : []
)

const assistant = computed(() => (props.message.role === "assistant" ? props.message : null))

const change = computed(() => (props.message.role === "canvas-change" ? props.message : null))

const skillLoaded = computed(() => (props.message.role === "skill-loaded" ? props.message : null))

/** 这条消息的全部任务条目（平铺；嵌套的由父条目自己挂） */
const allSubtasks = computed(() => assistant.value?.subtasks ?? [])

/** 入口 agent 发起的任务条目（没有 parentId，或父条目不在这条消息里 —— 容错，当顶层画）按它那次 run_agent 的 id 认 */
const topSubtasks = computed(() => {
  const ids = new Set(allSubtasks.value.map((task) => task.id))
  return allSubtasks.value.filter((task) => !task.parentId || !ids.has(task.parentId))
})

const subtaskByCall = computed(() => {
  const map = new Map<string, AgentSubtaskView>()
  for (const task of topSubtasks.value) map.set(task.toolCallId, task)
  return map
})

/** 对不上任何一条工具调用的顶层任务（不该有，容错）：排在时间线最后 */
const looseSubtasks = computed(() => {
  const ids = new Set(assistant.value?.toolCalls.map((call) => call.id) ?? [])
  return topSubtasks.value.filter((task) => !ids.has(task.toolCallId))
})

/** 正文切成段：每段文字和它的位置（旧记录没有分段 = 一段，位置算在所有工具调用之后） */
const textParts = computed(() => {
  const message = assistant.value
  if (!message || !message.text) return []
  const count = message.toolCalls.length
  const marks = (Array.isArray(message.textSegments) ? message.textSegments : [])
    .filter((item) => Number.isInteger(item.at) && item.at >= 0 && item.at < message.text.length)
    .slice()
    .sort((a, b) => a.at - b.at)
  const [first] = marks
  if (!first) return [{ text: message.text, position: count }]
  // 第一段之前还有字（不该有，容错）：算进第一段
  if (first.at > 0) marks[0] = { ...first, at: 0 }
  return marks
    .map((mark, index) => ({ text: message.text.slice(mark.at, marks[index + 1]?.at ?? message.text.length).trim(), position: mark.position }))
    .filter((part) => part.text)
})

/** 正文：最后一条工具调用之后的那些段（流式时最后一段还在长；一调工具它就挪进时间线） */
const body = computed(() => {
  const count = assistant.value?.toolCalls.length ?? 0
  return textParts.value
    .filter((part) => !(part.position >= 0 && part.position < count))
    .map((part) => part.text)
    .join("\n\n")
})

type Step =
  | { kind: "reasoning"; key: string; reasoning: AgentReasoningView }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; call: AgentToolCallView }
  | { kind: "subtask"; key: string; task: AgentSubtaskView }

/** 时间线：思考段按 `position` 插在工具调用之间（同一位置的按出现先后），位置越界的排到最后 */
const steps = computed<Step[]>(() => {
  const message = assistant.value
  if (!message) return []
  const reasoning = Array.isArray(message.reasoning) ? message.reasoning : []
  const out: Step[] = []
  const pushReasoning = (match: (position: number) => boolean) => {
    for (const item of reasoning) {
      if (match(item.position)) out.push({ kind: "reasoning", key: `r:${item.id}`, reasoning: item })
    }
  }
  message.toolCalls.forEach((call, index) => {
    pushReasoning((position) => position === index)
    textParts.value.forEach((part, at) => {
      if (part.position === index) out.push({ kind: "text", key: `x:${at}`, text: part.text })
    })
    const task = isAgentRunToolName(call.name) ? subtaskByCall.value.get(call.id) : undefined
    out.push(task ? { kind: "subtask", key: `s:${task.id}`, task } : { kind: "tool", key: `t:${call.id}`, call })
  })
  const count = message.toolCalls.length
  pushReasoning((position) => !(position >= 0 && position < count))
  for (const task of looseSubtasks.value) out.push({ kind: "subtask", key: `s:${task.id}`, task })
  return out
})

/** 什么都还没有（刚开流、模型还没吐字也没想）：垫一行「思考中」 */
const waiting = computed(
  () => Boolean(props.streaming) && !!assistant.value && !body.value && steps.value.length === 0 && !assistant.value.error
)
</script>

<template>
  <Message v-if="props.message.role === 'user'" align="end" data-role="user">
    <MessageContent>
      <AttachmentGroup
        v-if="attachments.length > 0"
        class="ml-8 max-w-[calc(100%-2rem)] gap-1.5 self-end"
        aria-label="附件"
        data-role="user-attachments"
      >
        <Attachment
          v-for="item in attachments"
          :key="item.key"
          state="done"
          orientation="vertical"
          size="xs"
          class="w-16"
          :title="item.name"
          :data-attachment="item.key"
        >
          <AttachmentMedia
            :variant="agentAttachmentKind(item.contentType) === 'file' ? 'icon' : 'image'"
            class="group-data-[size=xs]/attachment:w-full"
          >
            <AssetPreview :kind="agentAttachmentKind(item.contentType)" :src="item.url" :name="item.name" size="icon" />
          </AttachmentMedia>
          <AttachmentTrigger as="a" :href="item.url" target="_blank" rel="noopener noreferrer" :aria-label="`打开附件 ${item.name}`" />
        </Attachment>
      </AttachmentGroup>
      <Bubble v-if="segments.length > 0" align="end" variant="tinted" class="max-w-[calc(100%-2rem)]">
        <BubbleContent class="whitespace-pre-wrap" data-role="user-text">
          <template v-for="(segment, index) in segments" :key="index">
            <FlowAgentMention v-if="segment.kind === 'mention'" :node-id="segment.id" class="mx-0.5" />
            <template v-else>{{ segment.text }}</template>
          </template>
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>

  <div v-else-if="change" class="text-xs" data-role="canvas-change" :data-scope="change.scope">
    <TraceCollapsible v-if="change.items.length > 0" :unmount-on-hide="false">
      <TraceCollapsibleTrigger>
        <TraceLine class="text-xs">
          <TraceIcon><Eye /></TraceIcon>
          <TraceTitle class="whitespace-normal" data-role="canvas-change-summary">{{ change.summary }}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent class="text-xs">
        <ul class="space-y-0.5" data-role="canvas-change-items">
          <li v-for="(item, index) in change.items" :key="index" class="break-words">{{ item }}</li>
          <li v-if="change.omitted > 0">…另有 {{ change.omitted }} 处改动</li>
        </ul>
      </TraceCollapsibleContent>
    </TraceCollapsible>
    <TraceLine v-else class="text-xs">
      <TraceIcon><Eye /></TraceIcon>
      <TraceTitle class="whitespace-normal" data-role="canvas-change-summary">{{ change.summary }}</TraceTitle>
    </TraceLine>
  </div>

  <TraceLine v-else-if="skillLoaded" class="text-xs" data-role="skill-loaded" :data-skill="skillLoaded.skill.id">
    <TraceIcon><Puzzle /></TraceIcon>
    <TraceTitle class="whitespace-normal">已加载：{{ skillLoaded.skill.title }}</TraceTitle>
  </TraceLine>

  <Message v-else-if="assistant" class="pr-4" data-role="assistant">
    <MessageContent class="gap-2">
      <Trace v-if="steps.length > 0" data-role="assistant-steps">
        <template v-for="step in steps" :key="step.key">
          <FlowAgentReasoning v-if="step.kind === 'reasoning'" :reasoning="step.reasoning" />
          <div v-else-if="step.kind === 'text'" class="text-foreground" data-role="assistant-interim">
            <FlowAgentMarkdown :text="step.text" />
          </div>
          <FlowAgentSubtask v-else-if="step.kind === 'subtask'" :task="step.task" :tasks="allSubtasks" />
          <FlowAgentToolCall v-else :call="step.call" />
        </template>
      </Trace>

      <FlowAgentMarkdown v-if="body" :text="body" />
      <p v-else-if="waiting" class="shimmer text-muted-foreground motion-reduce:shimmer-none" data-role="assistant-waiting">
        思考中…
      </p>

      <div
        v-if="assistant.error"
        class="flex items-start gap-1.5 text-xs text-destructive"
        data-role="assistant-error"
      >
        <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
        <FlowAgentError :text="assistant.error" />
      </div>

      <MessageFooter v-if="assistant.usage" class="px-0">
        <FlowAgentUsage :usage="assistant.usage" />
      </MessageFooter>
    </MessageContent>
  </Message>
</template>
