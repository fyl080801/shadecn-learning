<script setup lang="ts">
import { computed } from "vue"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useFlowEditor } from "@/composables/flow"

/**
 * 左上角标题胶囊右边那一枚：正在编辑这张画布的人。
 *
 * 样式和标题胶囊、底部工具栏保持一致（圆角胶囊 + 毛玻璃 + 投影），
 * 头像用堆叠的方式排，人多了收成「+N」。
 * 这里不做任何判断逻辑，谁在线、什么颜色都由 `presence` 算好。
 */

/** 最多摆几个头像，多的收进 +N */
const MAX_AVATARS = 5

const { presence } = useFlowEditor()

const shown = computed(() => presence.members.value.slice(0, MAX_AVATARS))
const overflow = computed(() => Math.max(0, presence.members.value.length - MAX_AVATARS))

/** 收起来的那几个人的名字，鼠标移上去能看全 */
const overflowNames = computed(() =>
  presence.members.value
    .slice(MAX_AVATARS)
    .map((peer) => peer.user.name)
    .join("、")
)
</script>

<template>
  <TooltipProvider :delay-duration="150">
    <!-- 还没连上、也还没解析出任何人时整枚不显示，免得画布左上角挂个空壳 -->
    <!-- h-10 跟标题胶囊同高，两枚并排时上下沿要齐 -->
    <div
      v-if="shown.length > 0"
      class="flex h-10 items-center gap-2 rounded-full border bg-card/95 pl-3 pr-3.5 shadow-lg backdrop-blur"
    >
      <Tooltip>
        <TooltipTrigger as-child>
          <span
            class="size-1.5 shrink-0 rounded-full transition-colors"
            :class="presence.connected.value ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
          />
        </TooltipTrigger>
        <TooltipContent>
          {{ presence.connected.value ? "协同已连接" : "协同连接中断，正在重连…" }}
        </TooltipContent>
      </Tooltip>

      <!--
        堆叠的遮挡关系：靠左的压在靠右的上面（z-index 递减）。
        DOM 顺序天然是后来者盖前者，正好相反，所以这里显式给 z-index ——
        「我」永远排在第一个，也就永远是完整露出来的那个。
      -->
      <div class="flex -space-x-2">
        <Tooltip v-for="(peer, index) in shown" :key="peer.clientId">
          <TooltipTrigger as-child>
            <!-- 外面套一层：内圈是这个人的颜色，外圈是卡片色，堆叠时才分得开 -->
            <span
              class="relative rounded-full p-[2px] ring-2 ring-card"
              :style="{ backgroundColor: peer.user.color, zIndex: shown.length - index }"
            >
              <FlowPresenceAvatar :user="peer.user" class="size-7" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {{ peer.user.name }}<template v-if="peer.isSelf">（我）</template>
          </TooltipContent>
        </Tooltip>

        <Tooltip v-if="overflow > 0">
          <TooltipTrigger as-child>
            <span
              class="relative z-0 flex size-8 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground ring-2 ring-card"
            >
              +{{ overflow }}
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ overflowNames }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </TooltipProvider>
</template>
