<script setup lang="ts">
import type { Component } from "vue"
import { LocateFixed, Move, Rotate3d, Scaling } from "@lucide/vue"

import { useDirectorTransform } from "./useDirectorTransform"
import { viewportResetRequestId } from "./directorState"
import type { DirectorTransformMode } from "./useDirectorTransform"

const { mode, isModeAllowed, translate, rotate, scale } = useDirectorTransform()

interface TransformAction {
  key: DirectorTransformMode
  label: string
  icon: Component
  run: () => void
}

const actions: TransformAction[] = [
  // 源项目用的是自家 iconfont（icon-move / icon-rotate / icon-scale），这里换成 lucide 的对应图标。
  { key: "translate", label: "移动", icon: Move, run: translate },
  { key: "rotate", label: "旋转", icon: Rotate3d, run: rotate },
  { key: "scale", label: "缩放", icon: Scaling, run: scale }
]

// 有的调节器只认其中一种模式（机位注视端点只能移动），此时其余按钮置灰——按下一个什么
// 也不会发生的按钮，用户读到的是「工具栏坏了」。谁开放哪几种由 directorGizmoOwner 一处
// 声明，这里不认识具体是谁在被调节。
function isDisabled(action: TransformAction): boolean {
  return !isModeAllowed(action.key)
}

// 与 DirectorViewHelper 非父子关系，通过共享令牌触发其内部的轨道复位动画
function resetViewport() {
  viewportResetRequestId.value += 1
}
</script>

<template>
  <div
    class="director-transform-controls pointer-events-auto absolute z-10 flex flex-col gap-2"
  >
    <button
      v-for="action in actions"
      :key="action.key"
      type="button"
      class="director-transform-btn"
      :class="mode === action.key && 'director-transform-btn--active'"
      :aria-label="action.label"
      :aria-pressed="mode === action.key"
      :disabled="isDisabled(action)"
      @click="action.run"
    >
      <component :is="action.icon" class="size-4" aria-hidden="true" />
      <span
        class="director-transform-tooltip bg-popover text-popover-foreground rounded-md px-3 text-xs shadow-md"
      >
        <span
          class="director-transform-tooltip__arrow bg-popover"
          aria-hidden="true"
        ></span>
        {{ action.label }}
      </span>
    </button>
    <button
      type="button"
      class="director-transform-btn"
      aria-label="重置视角"
      @click="resetViewport"
    >
      <LocateFixed class="size-4" aria-hidden="true" />
      <span
        class="director-transform-tooltip bg-popover text-popover-foreground rounded-md px-3 text-xs shadow-md"
      >
        <span
          class="director-transform-tooltip__arrow bg-popover"
          aria-hidden="true"
        ></span>
        重置视角
      </span>
    </button>
  </div>
</template>

<style scoped>
.director-transform-controls {
  /* 紧贴 DirectorViewHelper（罗盘）下方，同停靠视口区域右上角，间距 16px。
    right 与 .director-view-helper 保持一致，避免左右漂移；top 对齐罗盘底部
    （罗盘 top:16px + size 72px + 间距 8px）。width 与罗盘 size 等宽，圆形按钮在列内
    右对齐（与罗盘右缘停靠对齐）。 */
  top: calc(16px + 72px + 8px);
  right: 16px;
  width: 72px;
  align-items: flex-end;
}

.director-transform-btn {
  position: relative;
  display: flex;
  width: 40px;
  height: 40px;
  padding: 0 8px;
  justify-content: center;
  align-items: center;
  gap: 4px;
  border-radius: 100px;
  background: rgba(0, 0, 0, 0.5);
  /* 按钮浮在 3D 画布上而不是页面底色上，故不跟随明暗主题，固定用半透明黑底 + 白色图标。 */
  color: rgba(255, 255, 255, 0.85);
  border: none;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.director-transform-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.director-transform-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.director-transform-btn--active {
  color: #2cfff8;
}

/* 原生 hover tooltip：源项目里 reka-ui Popper 在 z-[2000] fixed 浮层内定位失效，
   故改用纯 CSS 定位。:hover 由浏览器原生判定，不依赖 reka-ui 指针检测，
   也就不受 3D 视口 canvas 指针事件干扰。配色取主题的 popover 色。 */
.director-transform-tooltip {
  position: absolute;
  top: 50%;
  right: calc(100% + 8px);
  transform: translateY(-50%);
  z-index: 2010;
  display: flex;
  /* 显式 width，规避 Safari/WebKit 对 position:absolute + display:flex +
    仅设置 right（无 left）时 shrink-to-fit 宽度算成 0 的已知 bug，
    该 bug 会连带导致 right 的定位解算错误。 */
  width: max-content;
  height: 28px;
  align-items: center;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.16s ease;
}

.director-transform-tooltip__arrow {
  position: absolute;
  right: -3px;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  transform: translateY(-50%) rotate(45deg);
}

.director-transform-btn:hover .director-transform-tooltip {
  opacity: 1;
}
</style>
