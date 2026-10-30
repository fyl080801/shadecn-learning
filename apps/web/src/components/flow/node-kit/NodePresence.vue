<script setup lang="ts">
import { computed } from "vue"
import { Bot } from "@lucide/vue"
import { agentHolderLabel, type AgentActiveRunView } from "@shadecn/shared/agent"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { useOptionalFlowAgentPanel } from "@/composables/flow/agent-panel"

import { useNodePart } from "./context"

/**
 * 谁正在动这个节点（远端）—— **宿主内置**，每个节点都显示，不是能力、类型关不掉（REQ-NODEKIT §10.4）：
 * 「谁在动这个节点」是协同的公共约定，不该因类型而异。个人画布上 presence 不运行，这里自然为空。
 *
 * **只是提示，不是限制** —— 谁都可以同时改同一个节点，CRDT 负责合并：
 * 改不同字段各自保留，改同一字段则收敛到同一个结果。
 *
 * **agent 的占用标签也在这里**（docs/20 §3.4、§3.10.8）：任务列表里哪一轮的 `occupies` 含这个节点，就贴一枚
 * 「某某的助手」（个人画布只说「助手」），图标和配色和人的区分开；点它展开对话框、打开那一轮所在的会话。
 * 来源只有服务端推的任务列表（到 `expiresAt` 没续上的那一项已经被去掉了），两种画布都有。
 * 它挡的只是别的 agent 的写（服务端判），人照常编辑。
 */
const ctx = useNodePart()

const occupants = computed(() => ctx.editor.presence.occupantsOf("node", ctx.id))

const panel = useOptionalFlowAgentPanel()
const holders = computed(() => (panel ? panel.agent.activeRuns.value.filter((run) => run.occupies.includes(ctx.id)) : []))
const holderText = (run: AgentActiveRunView) =>
  agentHolderLabel(run.owner, { mine: run.mine, showOwner: panel?.agent.showOwners.value ?? false })
</script>

<template>
  <!-- 谁在动它就贴谁的头像 + 名字（纯提示），颜色和那个人的光标一致 -->
  <span
    v-for="peer in occupants"
    :key="peer.clientId"
    class="flex items-center gap-1 rounded-full py-[2px] pl-[2px] pr-1.5 text-[10px] font-medium leading-none text-white shadow-sm"
    :style="{ backgroundColor: peer.user.color }"
  >
    <FlowPresenceAvatar :user="peer.user" class="size-3.5" />
    {{ peer.user.name }}
  </span>
  <!-- agent 的占用：机器人图标 + 「某某的助手」，点开那个会话 -->
  <button
    v-for="run in holders"
    :key="run.runId"
    type="button"
    class="nodrag nopan flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-primary/60 bg-primary/10 py-[2px] pl-1 pr-1.5 text-[10px] font-medium leading-none text-primary shadow-sm hover:bg-primary/20"
    data-testid="node-agent-tag"
    :title="`${holderText(run)}正在修改这个节点，点击查看会话`"
    @click.stop="panel?.showConversation(run.conversationId)"
  >
    <Bot class="size-3" />
    {{ holderText(run) }}
  </button>
</template>
