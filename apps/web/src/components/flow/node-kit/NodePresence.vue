<script setup lang="ts">
import { computed } from "vue"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"

import { useNodePart } from "./context"

/**
 * 谁正在动这个节点（远端）—— **宿主内置**，每个节点都显示，不是能力、类型关不掉（REQ-NODEKIT §10.4）：
 * 「谁在动这个节点」是协同的公共约定，不该因类型而异。个人画布上 presence 不运行，这里自然为空。
 *
 * **只是提示，不是限制** —— 谁都可以同时改同一个节点，CRDT 负责合并：
 * 改不同字段各自保留，改同一字段则收敛到同一个结果。
 */
const ctx = useNodePart()

const occupants = computed(() => ctx.editor.presence.occupantsOf("node", ctx.id))
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
</template>
