<script setup lang="ts">
import { computed } from "vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import { splitMentions } from "./nodeMention"

/**
 * 会话标题：原文里可能含 `@{node:<id>}`，按提及渲染成 badge（名字现查画布）；附件提及只显示「@附件」，
 * 其余文字原样；整体单行截断。头部和历史列表共用。
 */
const props = defineProps<{ text: string }>()

const segments = computed(() => splitMentions(props.text.replace(/\s+/g, " ")))
</script>

<template>
  <span class="block overflow-hidden text-ellipsis whitespace-nowrap">
    <template v-for="(segment, index) in segments" :key="index">
      <FlowAgentMention v-if="segment.kind === 'mention'" :node-id="segment.id" class="mx-0.5" />
      <!-- 附件提及：标题在历史列表里也显示，那里查不到会话的附件（服务端起的标题已换成文件名，这里只兜底旧标题） -->
      <template v-else-if="segment.kind === 'attachment'">@附件</template>
      <template v-else>{{ segment.text }}</template>
    </template>
  </span>
</template>
