<script setup lang="ts">
import { computed } from "vue"
import { getBezierPath, Position, useVueFlow } from "@vue-flow/core"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 别人的**操作反馈**：鼠标（箭头 + 头像 + 名字）和正在拉的连线。
 *
 * 都属于反馈层（awareness）：易失、不落库、丢一帧也无所谓。
 *
 * **必须放在 `<VueFlow>` 的 `#zoom-pane` 插槽里** —— 那个插槽渲染在
 * `.vue-flow__transformationpane` 内部，和节点、连线同一层，缩放平移的变换由
 * Vue Flow 自己维护。所以这里的 `left/top: 0` + `translate(画布坐标)` 就是
 * 正确的位置，不需要自己算视口（默认插槽 `<slot>` 在变换之外，放这儿会不跟随）。
 *
 * 唯一自己算的是反向缩放：光标是「界面」不是「内容」，不该跟着画布一起变大变小。
 */
const { presence } = useFlowEditor()
const { viewport } = useVueFlow()

const counterScale = computed(() => 1 / (viewport.value.zoom || 1))

/**
 * 别人正在拉的线：从他上报的起点画到他的光标。
 *
 * 用 Vue Flow 自己的 `getBezierPath` 算路径，形状和本地拉线时看到的那条一致 ——
 * 手搓一条曲线只会长得不一样。
 */
const connections = computed(() =>
  presence.connections.value.map((peer) => {
    const [path] = getBezierPath({
      sourceX: peer.connecting.from.x,
      sourceY: peer.connecting.from.y,
      sourcePosition: Position.Right,
      targetX: peer.cursor.x,
      targetY: peer.cursor.y,
      targetPosition: Position.Left
    })
    return { clientId: peer.clientId, color: peer.user.color, path }
  })
)
</script>

<template>
  <!--
    连线浮层铺满整个变换层：SVG 里的坐标就是画布坐标，
    线宽做反向缩放，缩到很小时也不会细得看不见。
  -->
  <svg
    v-if="connections.length > 0"
    class="pointer-events-none absolute left-0 top-0 overflow-visible"
    :style="{ zIndex: 9999 }"
    width="1"
    height="1"
  >
    <path
      v-for="line in connections"
      :key="line.clientId"
      :d="line.path"
      fill="none"
      stroke-linecap="round"
      stroke-dasharray="6 4"
      :stroke="line.color"
      :stroke-width="2 * counterScale"
    />
  </svg>

  <div
    v-for="peer in presence.cursors.value"
    :key="peer.clientId"
    class="pointer-events-none absolute left-0 top-0 origin-top-left"
    :style="{
      transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px) scale(${counterScale})`,
      // 节点自带 z-index，光标要压在它们上面
      zIndex: 10000
    }"
  >
    <svg viewBox="0 0 16 16" class="size-4 drop-shadow-sm" :style="{ color: peer.user.color }">
      <path
        d="M1 1 L1 13.2 L4.3 10 L6.5 15 L9 13.9 L6.8 9 L11.2 9 Z"
        fill="currentColor"
        stroke="#fff"
        stroke-width="1.1"
        stroke-linejoin="round"
      />
    </svg>

    <div
      class="ml-2.5 mt-0.5 flex w-max items-center gap-1 rounded-full py-[2px] pl-[2px] pr-2 text-[11px] font-medium leading-none text-white shadow-sm"
      :style="{ backgroundColor: peer.user.color }"
    >
      <FlowPresenceAvatar :user="peer.user" class="size-4" />
      {{ peer.user.name }}
    </div>
  </div>
</template>
