<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, CircleCheck, LoaderCircle } from "@lucide/vue"
import type { AgentChatMessage } from "@shadecn/shared/agent"
import FlowAgentMention from "./FlowAgentMention.vue"
import { splitMentions } from "./nodeMention"

/**
 * 对话里的一条消息。
 *
 * 用户消息：文字 + 提及 badge（和输入框里同一个组件，名字现查，删了的节点灰掉）。
 * assistant 消息：流式文字 + 工具调用条目（名字 / 一句话 / 运行中·完成·出错），
 * 一轮以失败或中止收尾时在最后挂一行原因。
 */
const props = defineProps<{
  message: AgentChatMessage
  /** 这条是不是本轮正在流式拼出来的那条：没字也没工具时显示「思考中」 */
  streaming?: boolean
}>()

const segments = computed(() =>
  props.message.role === "user" ? splitMentions(props.message.text) : []
)

const assistant = computed(() => (props.message.role === "assistant" ? props.message : null))
</script>

<template>
  <div
    v-if="props.message.role === 'user'"
    class="ml-8 self-end rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap break-words"
    data-role="user"
  >
    <template v-for="(segment, index) in segments" :key="index">
      <FlowAgentMention v-if="segment.kind === 'mention'" :node-id="segment.id" class="mx-0.5" />
      <template v-else>{{ segment.text }}</template>
    </template>
  </div>

  <div v-else-if="assistant" class="mr-4 space-y-2 text-sm" data-role="assistant">
    <ul v-if="assistant.toolCalls.length > 0" class="space-y-1">
      <li
        v-for="call in assistant.toolCalls"
        :key="call.id"
        class="flex items-start gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
        :data-tool-status="call.status"
      >
        <LoaderCircle
          v-if="call.status === 'running'"
          class="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
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
    </ul>

    <p v-if="assistant.text" class="whitespace-pre-wrap break-words">{{ assistant.text }}</p>
    <p
      v-else-if="props.streaming && assistant.toolCalls.length === 0 && !assistant.error"
      class="text-muted-foreground"
    >
      思考中…
    </p>

    <p
      v-if="assistant.error"
      class="flex items-start gap-1.5 text-xs text-destructive"
      data-role="assistant-error"
    >
      <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
      <span class="break-words">{{ assistant.error }}</span>
    </p>
  </div>
</template>
