<script setup lang="ts">
import { computed } from "vue"
import type { AgentUserView } from "@shadecn/shared/agent"
import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { presenceColor } from "@/lib/presence"

/**
 * 会话 / 任务的发起人：小头像 + 名字，可选「我的」标记。只在项目画布上用（个人画布不显示用户标识，docs/20 §3.10.5）。
 * 头像和在场层同一个组件、同一套配色（按 id 算），所以和画布左上角的头像对得上是谁。
 */
const props = defineProps<{
  owner: AgentUserView
  mine?: boolean
}>()

const user = computed(() => ({ ...props.owner, color: presenceColor(props.owner.id) }))
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-1.5" data-role="owner">
    <FlowPresenceAvatar :user="user" class="size-4 shrink-0" />
    <span class="truncate" data-role="owner-name">{{ owner.name }}</span>
    <span
      v-if="props.mine"
      class="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-medium leading-4 text-primary"
      data-role="mine"
    >
      我的
    </span>
  </span>
</template>
