<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

import { Grid2x2 } from "lucide-vue-next"
import { aspectRatio } from "./directorState"

// 各画幅比例的宽高比（宽 / 高）。`auto` 不显示取景框。
const RATIOS: Record<Exclude<(typeof aspectRatio)["value"], "auto">, number> = {
  "21:9": 21 / 9,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "3:4": 3 / 4,
  "9:16": 9 / 16
}

const containerRef = ref<HTMLDivElement | null>(null)
const size = ref({ w: 0, h: 0 })

// 取景框与视口边缘保留的余地（像素）。底部在边缘余地之上再叠加工具栏
// 占位（bottom-4 偏移 + 工具栏高度 + 间距），使取景框不贴边、也不压住工具栏。
const EDGE_MARGIN = 24
const TOOLBAR_CLEARANCE = 64

const active = computed(() => aspectRatio.value !== "auto")

// 摄影参考线（3×3 九宫格）的开启状态，由取景框右上角的开关切换。
const showGuideLines = ref(false)

// 在视口容器内（扣除边缘余地与底部工具栏占位后）按所选宽高比 contain
// 适配并居中的取景框（像素坐标）。
const frame = computed(() => {
  const { w, h } = size.value
  if (!active.value || w === 0 || h === 0) return null
  const a = RATIOS[aspectRatio.value as Exclude<(typeof aspectRatio)["value"], "auto">]
  if (!a) return null
  const marginTop = EDGE_MARGIN
  const marginBottom = EDGE_MARGIN + TOOLBAR_CLEARANCE
  const marginX = EDGE_MARGIN
  const availW = Math.max(0, w - marginX * 2)
  const availH = Math.max(0, h - marginTop - marginBottom)
  let fw: number
  let fh: number
  if (a >= availW / availH) {
    fw = availW
    fh = availW / a
  } else {
    fh = availH
    fw = availH * a
  }
  return {
    x: marginX + (availW - fw) / 2,
    y: marginTop + (availH - fh) / 2,
    w: fw,
    h: fh
  }
})

let ro: ResizeObserver | null = null
function measure() {
  const el = containerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  size.value = { w: rect.width, h: rect.height }
}

onMounted(() => {
  measure()
  if (containerRef.value && "ResizeObserver" in window) {
    ro = new ResizeObserver(measure)
    ro.observe(containerRef.value)
  } else {
    window.addEventListener("resize", measure)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener("resize", measure)
})
</script>

<template>
  <!-- 叠加在视口画布之上的纯 CSS 取景层。pointer-events-none 使其不拦截
       视口的轨道/拾取交互；模糊仅作用于画布像素，不进入 three-editor 渲染。 -->
  <div
    ref="containerRef"
    class="pointer-events-none absolute inset-0 overflow-hidden"
    aria-hidden="true"
  >
    <template v-if="frame">
      <!-- 周边模糊遮罩：四块矩形围绕中央取景框，仅框外区域被模糊与压暗 -->
      <div
        class="absolute left-0 right-0 top-0 bg-black/40 backdrop-blur-md"
        :style="{ height: frame.y + 'px' }"
      />
      <div
        class="absolute bottom-0 left-0 right-0 bg-black/40 backdrop-blur-md"
        :style="{ height: size.h - frame.y - frame.h + 'px' }"
      />
      <div
        class="absolute left-0 bg-black/40 backdrop-blur-md"
        :style="{
          top: frame.y + 'px',
          height: frame.h + 'px',
          width: frame.x + 'px'
        }"
      />
      <div
        class="absolute right-0 bg-black/40 backdrop-blur-md"
        :style="{
          top: frame.y + 'px',
          height: frame.h + 'px',
          width: size.w - frame.x - frame.w + 'px'
        }"
      />
      <!-- 中央取景框 -->
      <div
        class="absolute border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        :style="{
          left: frame.x + 'px',
          top: frame.y + 'px',
          width: frame.w + 'px',
          height: frame.h + 'px'
        }"
      />
      <!-- 取景框右上角：摄影参考线开关 -->
      <button
        type="button"
        class="pointer-events-auto absolute flex size-6 items-center justify-center rounded-sm border border-white/30 bg-black/40 text-white/70 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
        :class="showGuideLines && 'border-white/50 bg-white/20 text-white'"
        :style="{
          left: frame.x + frame.w - 28 + 'px',
          top: frame.y + 4 + 'px'
        }"
        :title="showGuideLines ? '关闭摄影参考线' : '开启摄影参考线'"
        @click="showGuideLines = !showGuideLines"
      >
        <Grid2x2 class="size-3.5" />
      </button>
      <!-- 3×3 摄影参考线：2 竖线 + 2 横线，将取景框均分为九宫格 -->
      <template v-if="showGuideLines">
        <div
          v-for="i in 2"
          :key="`v${i}`"
          class="absolute bg-white/50"
          :style="{
            left: frame.x + (frame.w * i) / 3 + 'px',
            top: frame.y + 'px',
            width: '1px',
            height: frame.h + 'px'
          }"
        />
        <div
          v-for="i in 2"
          :key="`h${i}`"
          class="absolute bg-white/50"
          :style="{
            left: frame.x + 'px',
            top: frame.y + (frame.h * i) / 3 + 'px',
            height: '1px',
            width: frame.w + 'px'
          }"
        />
      </template>
    </template>
  </div>
</template>
