<script setup lang="ts">
/**
 * 顶部拖动把手（能力 `drag-strip`，挂在 `overlay` 区）：节点整块 `pointer-events-none` 时**唯一可拖动的地方**。
 *
 * 名字在框外（`label` 区的 NodeToolbar），但拖动不能跟着挪过去 ——
 * NodeToolbar 是 teleport 到画布容器上的，在它上面按下鼠标不会变成拖节点。
 * 所以这里留一条贴着名字下方的把手：平时不画出来（分组是背景板，不该有一条常驻的横杠），
 * 指上去才浮出底色。
 */

/** 把手的高度，同时也是「名字下面那条」的视觉厚度 */
const HANDLE_HEIGHT = 24
</script>

<template>
  <div
    class="pointer-events-auto absolute inset-x-0 top-0 cursor-move rounded-t-md transition-colors hover:bg-muted-foreground/10"
    :style="{ height: `${HANDLE_HEIGHT}px` }"
    title="拖这里移动整个分组"
  />
</template>
