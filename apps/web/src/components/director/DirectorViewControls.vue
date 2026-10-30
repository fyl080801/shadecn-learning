<script setup lang="ts">
import { computed, ref } from "vue"
import { Compass, LocateFixed } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import DirectorViewHelper from "./DirectorViewHelper.vue"
import { viewportResetRequestId } from "./directorState"

/**
 * 导演台左下角的视图控件（和画布左下角的视图工具栏同款胶囊）：重置视角、视角罗盘显隐，外加罗盘本身。
 *
 * 罗盘像画布的小地图一样挂在开关按钮正上方，默认不显示。**收起用 `v-show`，不卸载**：
 * 「重置视角」靠罗盘内部 watch `viewportResetRequestId` 执行转回动画，卸了它重置就没人接了。
 * 机位视角下罗盘自己会藏起来（没有轨道可转），这时开着也看不到。
 *
 * 只管「怎么看」，不碰场景数据。必须渲染在 `ThreeEditor` 里 —— 罗盘要注入编辑器。
 */
const compassOpen = ref(false)
const compassLabel = computed(() => (compassOpen.value ? "隐藏视角罗盘" : "显示视角罗盘"))

/** 与罗盘非父子关系，通过共享令牌触发它内部的轨道复位动画 */
function resetViewport() {
  viewportResetRequestId.value += 1
}
</script>

<template>
  <div class="relative">
    <div v-show="compassOpen" class="absolute bottom-full left-0 mb-3.5" data-testid="director-compass">
      <DirectorViewHelper class="rounded-full bg-black/50" :size="96" />
    </div>

    <div class="flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 rounded-full"
            aria-label="重置视角"
            data-testid="director-view-reset"
            @click="resetViewport()"
          >
            <LocateFixed />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">重置视角</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" class="mx-1 data-[orientation=vertical]:h-5" />

      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="compassOpen ? 'secondary' : 'ghost'"
            size="icon"
            class="size-8 rounded-full"
            :aria-label="compassLabel"
            :aria-pressed="compassOpen"
            data-testid="director-compass-toggle"
            @click="compassOpen = !compassOpen"
          >
            <Compass />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{{ compassLabel }}</TooltipContent>
      </Tooltip>
    </div>
  </div>
</template>
