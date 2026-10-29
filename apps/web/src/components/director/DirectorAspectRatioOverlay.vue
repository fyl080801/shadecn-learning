<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

import { Grid2x2 } from "@lucide/vue"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { aspectRatio } from "./directorState"
import {
  computeAspectGateFrame,
  useCameraAspectGate
} from "./directorAspectGate"

const editor = useEditor()

const containerRef = ref<HTMLDivElement | null>(null)
const size = ref({ w: 0, h: 0 })

// 摄影参考线（3×3 九宫格）的开启状态，由取景框右上角的开关切换。
const showGuideLines = ref(false)

// 取景框几何：几何计算单点源在 directorAspectGate.ts（供叠加层绘制与相机分辨率闸门
// 复用同一份矩形）。本容器就是视口区域（面板列与时间轴都在其外），故只需让开仍悬浮
// 在视口上的纵向工具栏与右上角罗盘列；面板列显隐、时间轴开合都会改变容器尺寸，
// 经 ResizeObserver 重算即可。矩形宽高比严格等于所选比例。
const frame = computed(() =>
  computeAspectGateFrame(size.value.w, size.value.h, aspectRatio.value)
)

// 把同一份取景框施加为视口相机的分辨率闸门，使取景框内画面 = 机位预览（相机在所选
// 比例下的真实成片），导演视角与机位视角同理（作用于当前视口相机）。
useCameraAspectGate(editor, frame, size)

// 周边模糊遮罩：取景框四周四条互不重叠的矩形，各自 backdrop-blur。
//
// 刻意不用「铺满一层 + clip-path(evenodd) 挖洞」：视口区域现在是带圆角的卡片
// （DirectorConsoleModal 的 .director-viewport-region，border-radius + overflow:hidden），
// 祖先的圆角裁切会把 backdrop-filter 提升到独立渲染面，元素自身的 clip-path 不再
// 裁剪其模糊输出——取景框内也会跟着糊掉。四条矩形按几何直接避开取景框，模糊范围
// 由布局本身保证，不依赖任何裁剪语义。
//
// 边界与取景框严格相接（对齐到整像素避免亚像素缝），万一有半像素误差也被取景框
// 自身的 1px 边框盖住。四条矩形只负责「模糊」，压暗交给下面的 dimStyle——四条的
// 边界是取景框的外接矩形，压暗若也走这里，圆角外的四个小角落就会既不压暗也不
// 圆角，露出突兀的清晰直角。
interface BlurBand {
  key: string
  left: number
  top: number
  width: number
  height: number
}

const blurBands = computed<BlurBand[]>(() => {
  const f = frame.value
  const { w, h } = size.value
  if (!f || w === 0 || h === 0) return []
  const left = Math.round(f.x)
  const top = Math.round(f.y)
  const right = Math.round(f.x + f.w)
  const bottom = Math.round(f.y + f.h)
  const bandHeight = Math.max(0, bottom - top)
  return [
    { key: "top", left: 0, top: 0, width: w, height: top },
    {
      key: "bottom",
      left: 0,
      top: bottom,
      width: w,
      height: Math.max(0, h - bottom)
    },
    { key: "left", left: 0, top, width: left, height: bandHeight },
    {
      key: "right",
      left: right,
      top,
      width: Math.max(0, w - right),
      height: bandHeight
    }
  ].filter((band) => band.width > 0 && band.height > 0)
})

/** 取景框圆角，叠加层与压暗层共用。 */
const FRAME_RADIUS = 16

// 框外压暗：一个贴在取景框矩形上的元素，用超大 spread 的外阴影把框外整片压暗。
// 外阴影天然不画在自身 border-box 之内，且这块「挖空」严格贴合 border-radius，
// 于是压暗边界与取景框圆角完全一致（圆角外的小角落也照样压暗），全程只用到
// border-radius 与 box-shadow——不碰 clip-path/mask 这类在圆角卡片里对
// backdrop-filter 失效的裁剪方式。溢出容器的部分由容器的 overflow:hidden 收掉。
const dimStyle = computed(() => {
  const f = frame.value
  if (!f) return null
  const spread = Math.ceil(size.value.w + size.value.h)
  return {
    left: `${f.x}px`,
    top: `${f.y}px`,
    width: `${f.w}px`,
    height: `${f.h}px`,
    borderRadius: `${FRAME_RADIUS}px`,
    boxShadow: `0 0 0 ${spread}px rgba(0, 0, 0, 0.4)`
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
      <!-- 周边模糊：取景框上/下/左/右四条矩形，各自 backdrop-blur，
                 互不重叠也不覆盖取景框（几何见 blurBands），不带压暗 -->
      <div
        v-for="band in blurBands"
        :key="band.key"
        class="absolute backdrop-blur-md"
        :style="{
          left: `${band.left}px`,
          top: `${band.top}px`,
          width: `${band.width}px`,
          height: `${band.height}px`
        }"
      />
      <!-- 框外压暗：边界严格贴合取景框圆角（见 dimStyle） -->
      <div class="absolute" :style="dimStyle" />
      <!-- 中央取景框 -->
      <div
        class="absolute border"
        :style="{
          left: frame.x + 'px',
          top: frame.y + 'px',
          width: frame.w + 'px',
          height: frame.h + 'px',
          borderColor: '#D9D9D9',
          borderRadius: `${FRAME_RADIUS}px`
        }"
      />
      <!-- 取景框右上角：摄影参考线开关 -->
      <button
        type="button"
        class="pointer-events-auto absolute flex size-6 items-center justify-center rounded-sm border border-white/30 bg-black/40 text-white/70 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
        :class="showGuideLines && 'border-white/50 bg-white/20 text-white'"
        :style="{
          left: frame.x + 8 + 'px',
          top: frame.y + 8 + 'px'
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
