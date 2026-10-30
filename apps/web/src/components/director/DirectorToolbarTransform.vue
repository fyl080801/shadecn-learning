<script setup lang="ts">
import type { Component } from "vue"
import { Move, Rotate3d, Scaling } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useDirectorTransform, type DirectorTransformMode } from "./useDirectorTransform"

/**
 * 导演台底部工具栏里的移动 / 旋转 / 缩放三枚按钮（画布同款圆钮）。
 *
 * 单独成组件：`useDirectorTransform` 要从 `ThreeEditor` 注入编辑器，舞台自己就是 provide 的那一层，拿不到。
 * 当前调节器不认的模式置灰（机位注视端点只能移动，谁开放哪几种由 `directorGizmoOwner` 声明）。
 */
const { mode, isModeAllowed, translate, rotate, scale } = useDirectorTransform()

const actions: { key: DirectorTransformMode; label: string; icon: Component; run: () => void }[] = [
  { key: "translate", label: "移动", icon: Move, run: translate },
  { key: "rotate", label: "旋转", icon: Rotate3d, run: rotate },
  { key: "scale", label: "缩放", icon: Scaling, run: scale }
]
</script>

<template>
  <Tooltip v-for="action in actions" :key="action.key">
    <TooltipTrigger as-child>
      <Button
        :variant="mode === action.key ? 'secondary' : 'ghost'"
        size="icon"
        class="size-8 rounded-full"
        :class="mode === action.key && 'text-primary'"
        :aria-label="action.label"
        :aria-pressed="mode === action.key"
        :disabled="!isModeAllowed(action.key)"
        :data-testid="`director-transform-${action.key}`"
        @click="action.run()"
      >
        <component :is="action.icon" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">{{ action.label }}</TooltipContent>
  </Tooltip>
</template>
