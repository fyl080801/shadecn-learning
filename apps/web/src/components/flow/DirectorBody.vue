<script setup lang="ts">
import { Clapperboard } from "@lucide/vue"

/**
 * 导演台节点的 body —— 一块正方形，中间一枚导演台图标（只是标识，不可点）。
 *
 * 打开导演台的按钮在节点右上角（`badge` 区，`DirectorOpenButton.vue`），和图片 / 视频的上传按钮同一个位置、
 * 同一套「按屏幕尺寸画」的规则。图标同空占位：按屏幕尺寸画、不随缩放变（`flow-screen.ts`）。
 */
</script>

<template>
  <div
    class="flex aspect-square w-full items-center justify-center rounded-[inherit] bg-muted/30 text-muted-foreground"
    data-testid="director-body"
  >
    <Clapperboard class="flow-screen-fixed size-8" aria-hidden="true" data-testid="director-icon" />
  </div>
</template>
