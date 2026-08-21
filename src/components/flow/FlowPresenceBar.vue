<script setup lang="ts">
import { computed } from "vue"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 左上角标题胶囊右边那一枚：正在编辑这张画布的人。
 *
 * 这里**只展示在线的人**，不展示连接状态、也不展示任何离线信息 ——
 * 连接断没断由标题胶囊里的同步状态文字负责说，两处都提示是重复的。
 * 谁在线、什么颜色都由 `presence` 算好，这个组件不做判断。
 *
 * 样式跟底部工具栏、标题胶囊是同一套：圆角胶囊 + 毛玻璃 + 投影，
 * 头像直接用工具栏圆按钮的尺寸（size-8），人多了收成「+N」。
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
    <!-- 一个人都还没解析出来时整枚不显示，免得画布左上角挂个空壳 -->
    <!-- h-10 + size-8 圆形内容：跟标题胶囊、底部工具栏同一套尺寸 -->
    <div
      v-if="shown.length > 0"
      class="flex h-10 items-center rounded-full border bg-card/95 px-1 shadow-lg backdrop-blur"
    >
      <!--
        堆叠的遮挡关系：靠左的压在靠右的上面（z-index 递减）。
        DOM 顺序天然是后来者盖前者，正好相反，所以这里显式给 z-index ——
        「我」永远排在第一个，也就永远是完整露出来的那个。
        ring 用卡片色，是堆叠时把相邻两个头像分开的那道缝。
      -->
      <div class="flex -space-x-2">
        <Tooltip v-for="(peer, index) in shown" :key="peer.clientId">
          <TooltipTrigger as-child>
            <FlowPresenceAvatar
              :user="peer.user"
              class="relative size-8 ring-2 ring-card"
              :style="{ zIndex: shown.length - index }"
            />
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
