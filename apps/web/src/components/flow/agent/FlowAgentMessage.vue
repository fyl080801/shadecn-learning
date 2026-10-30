<script setup lang="ts">
import { computed } from "vue"
import { ChevronRight, CircleAlert, CircleCheck, Eye, Puzzle } from "@lucide/vue"
import { AGENT_DELEGATE_TOOL_NAME, agentAttachmentKind, type AgentChatMessage, type AgentSubtaskView } from "@shadecn/shared/agent"
import AssetPreview from "@/components/flow/asset-upload/AssetPreview.vue"
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment"
import { Message, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import FlowAgentError from "./FlowAgentError.vue"
import FlowAgentMarkdown from "./FlowAgentMarkdown.vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import FlowAgentSubtask from "./FlowAgentSubtask.vue"
import { splitMentions } from "./nodeMention"

/**
 * 对话里的一条消息。
 *
 * 用户消息：文字 + 提及 badge（和输入框里同一个组件，名字现查，删了的节点灰掉）；带了附件时文字上方一排缩略图
 * （docs/20 §3.10.12，`ui/attachment` 的小方块，预览和输入区里的附件同一个组件，地址是对象存储的；点开在新标签页里看原文件）。只有附件没写字时不画文字气泡。
 * assistant 消息：工具调用条目（名字 / 一句话 / 运行中·完成·出错）+ 流式的 Markdown 正文（docs/20 F16），
 * 一轮以失败或中止收尾时在最后挂一行原因（模型报错按「状态码 + 上游错误体」拆开显示，见 `FlowAgentError`）。用户消息和 assistant 消息用 shadcn 的 `Message` 排版。
 * 画布改动通知（docs/20 §3.10.2）：灰色的一行系统提示（图标 + 概括），有条目时可以展开看每一处。
 * 技能加载（docs/23 §3.6）：同样灰色的一行「已加载：<技能标题>」。
 * 子任务（docs/20 §3.10.11）：父 agent 的 `delegate_task` 那一条工具调用画成可展开的子任务条目（`FlowAgentSubtask`，按 `toolCallId` 对上）；
 * 被拒、没派出去的 delegate_task 没有条目，照常是一条出错的工具调用。
 */
const props = defineProps<{
  message: AgentChatMessage
  /** 这条是不是本轮正在流式拼出来的那条：没字也没工具时显示「思考中」 */
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

/** 子任务条目按父 agent 那次 delegate_task 的 id 认 */
const subtaskByCall = computed(() => {
  const map = new Map<string, AgentSubtaskView>()
  for (const task of assistant.value?.subtasks ?? []) map.set(task.toolCallId, task)
  return map
})

/** 对不上任何一条工具调用的子任务（不该有，容错）：排在工具调用之后 */
const looseSubtasks = computed(() => {
  const ids = new Set(assistant.value?.toolCalls.map((call) => call.id) ?? [])
  return (assistant.value?.subtasks ?? []).filter((task) => !ids.has(task.toolCallId))
})

const subtaskOf = (call: { id: string; name: string }) =>
  call.name === AGENT_DELEGATE_TOOL_NAME ? subtaskByCall.value.get(call.id) : undefined
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
            <AssetPreview :kind="agentAttachmentKind(item.contentType)" :src="item.url" :name="item.name" />
          </AttachmentMedia>
          <AttachmentTrigger as="a" :href="item.url" target="_blank" rel="noopener noreferrer" :aria-label="`打开附件 ${item.name}`" />
        </Attachment>
      </AttachmentGroup>
      <div
        v-if="segments.length > 0"
        class="ml-8 self-end rounded-lg bg-primary/10 px-3 py-2 whitespace-pre-wrap break-words"
      >
        <template v-for="(segment, index) in segments" :key="index">
          <FlowAgentMention v-if="segment.kind === 'mention'" :node-id="segment.id" class="mx-0.5" />
          <template v-else>{{ segment.text }}</template>
        </template>
      </div>
    </MessageContent>
  </Message>

  <div
    v-else-if="change"
    class="flex items-start gap-1.5 text-xs text-muted-foreground"
    data-role="canvas-change"
    :data-scope="change.scope"
  >
    <Eye class="mt-0.5 size-3.5 shrink-0" />
    <details v-if="change.items.length > 0" class="group min-w-0 flex-1">
      <summary class="flex cursor-pointer list-none items-start gap-1 break-words [&::-webkit-details-marker]:hidden">
        <span class="min-w-0 flex-1" data-role="canvas-change-summary">{{ change.summary }}</span>
        <ChevronRight class="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <ul class="mt-1 space-y-0.5 border-l pl-2" data-role="canvas-change-items">
        <li v-for="(item, index) in change.items" :key="index" class="break-words">{{ item }}</li>
        <li v-if="change.omitted > 0">…另有 {{ change.omitted }} 处改动</li>
      </ul>
    </details>
    <span v-else class="min-w-0 flex-1 break-words" data-role="canvas-change-summary">{{ change.summary }}</span>
  </div>

  <div
    v-else-if="skillLoaded"
    class="flex items-start gap-1.5 text-xs text-muted-foreground"
    data-role="skill-loaded"
    :data-skill="skillLoaded.skill.id"
  >
    <Puzzle class="mt-0.5 size-3.5 shrink-0" />
    <span class="min-w-0 flex-1 break-words">已加载：{{ skillLoaded.skill.title }}</span>
  </div>

  <Message v-else-if="assistant" class="pr-4" data-role="assistant">
    <MessageContent class="gap-2">
      <ul v-if="assistant.toolCalls.length > 0 || looseSubtasks.length > 0" class="space-y-1">
        <template v-for="call in assistant.toolCalls" :key="call.id">
          <li v-if="subtaskOf(call)">
            <FlowAgentSubtask :task="subtaskOf(call)!" />
          </li>
          <li
            v-else
            class="flex items-start gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
            :data-tool-status="call.status"
          >
            <Spinner
              v-if="call.status === 'running'"
              class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            <CircleCheck v-else-if="call.status === 'done'" class="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
            <CircleAlert v-else class="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span class="min-w-0 flex-1">
              <span class="block break-words">{{ call.summary || call.name }}</span>
              <span class="block font-mono text-[10px] text-muted-foreground">{{ call.name }}</span>
              <span v-if="call.status === 'error' && call.error" class="block text-destructive">
                {{ call.error }}
              </span>
            </span>
          </li>
        </template>
        <li v-for="task in looseSubtasks" :key="task.id">
          <FlowAgentSubtask :task="task" />
        </li>
      </ul>

      <FlowAgentMarkdown v-if="assistant.text" :text="assistant.text" />
      <p
        v-else-if="props.streaming && assistant.toolCalls.length === 0 && !assistant.error"
        class="text-muted-foreground"
      >
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
    </MessageContent>
  </Message>
</template>
