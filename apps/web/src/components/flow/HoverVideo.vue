<script setup lang="ts">
import { ref, watch } from "vue"
import { Pause, Play, Volume2, VolumeX } from "@lucide/vue"

import { Slider } from "@/components/ui/slider"

/**
 * 「鼠标移上去就播放」的视频区：平时只画默认插槽（预览图 / 占位），鼠标进来才挂一个 `<video>`，
 * 绝对定位盖满整个区域（`inset-0` + `object-cover`，和预览图同样的裁法），鼠标离开就**卸掉**（不是暂停），
 * 换回插槽里的预览图。播放中的 `<video>` 各占一个合成层、各握一份解码器，常驻的话几十个节点就是几十层；
 * 用 `v-if` 卸掉，同一时刻最多只有鼠标下面那一个。
 *
 * 根元素就是播放区（class / style / data-* 透传过来）：调用方给它定尺寸、圆角和 `overflow-hidden`，
 * 视频跟着裁。`<video>` 循环、不带原生控件、不接指针事件 —— 拖动、选中、连线照旧落在节点上。
 * 播放控制是底部一条自己画的控制栏（播放 / 暂停、进度、声音），只有它是 `nodrag nopan`：
 * 原生 `controls` 要整块 `<video>` 接指针事件，按在画面上就拖不动节点了。
 *
 * 默认静音（不静音浏览器不让自动播放）；在这个节点上打开过声音，下次移上来接着有声音，
 * 浏览器不让有声自动播放就退回静音再播。
 *
 * 没有 `src` 就只是个普通容器；视频加载失败就收起，露回插槽内容。以后别的带可播放视频的节点直接套这一层。
 */
const props = defineProps<{
  /** 视频地址；空就不播放 */
  src?: string
  /** 视频还没出第一帧时垫的图，一般就是预览图 */
  poster?: string
}>()

const active = ref(false)
const video = ref<HTMLVideoElement | null>(null)
const paused = ref(true)
const muted = ref(true)
const currentTime = ref(0)
const duration = ref(0)

// 换了视频（重新上传 / 撤销）就停掉当前这次
watch(
  () => props.src,
  () => {
    active.value = false
  }
)

// 每次挂上 <video> 都从头开始播
watch(video, (element) => {
  currentTime.value = 0
  duration.value = 0
  paused.value = true
  if (element) void start(element)
})

async function start(element: HTMLVideoElement) {
  try {
    await element.play()
  } catch {
    // 有声自动播放被拦：退回静音再试一次；还不行就停在第一帧，等用户点播放
    if (element.muted) return
    muted.value = true
    element.muted = true
    await element.play().catch(() => {})
  }
}

function enter() {
  if (props.src) active.value = true
}

function togglePlay() {
  const element = video.value
  if (!element) return
  if (paused.value) void element.play().catch(() => {})
  else element.pause()
}

function toggleMute() {
  muted.value = !muted.value
}

function seek(value: number[] | undefined) {
  const element = video.value
  const time = value?.[0]
  if (!element || time === undefined) return
  element.currentTime = time
  currentTime.value = time
}

function onMetadata() {
  const value = video.value?.duration ?? 0
  duration.value = Number.isFinite(value) ? value : 0
}

/** 秒 → `m:ss` */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
</script>

<template>
  <div class="relative" @mouseenter="enter()" @mouseleave="active = false">
    <slot />
    <template v-if="active && src">
      <video
        ref="video"
        :src="src"
        :poster="poster || undefined"
        :muted="muted"
        loop
        playsinline
        preload="auto"
        class="pointer-events-none absolute inset-0 block h-full w-full object-cover"
        data-testid="hover-video"
        @play="paused = false"
        @pause="paused = true"
        @timeupdate="currentTime = video?.currentTime ?? 0"
        @loadedmetadata="onMetadata()"
        @durationchange="onMetadata()"
        @error="active = false"
      />
      <div
        class="nodrag nopan absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 pt-4 pb-1.5 text-white"
        data-testid="hover-video-controls"
        @dblclick.stop
      >
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded hover:bg-white/20"
          :aria-label="paused ? '播放' : '暂停'"
          data-testid="hover-video-play"
          @click.stop="togglePlay()"
        >
          <Play v-if="paused" class="size-3.5 fill-current" />
          <Pause v-else class="size-3.5 fill-current" />
        </button>
        <Slider
          :model-value="[currentTime]"
          :max="duration || 1"
          :step="0.01"
          :disabled="!duration"
          class="min-w-0 flex-1 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-white/30"
          aria-label="播放进度"
          data-testid="hover-video-progress"
          @update:model-value="seek($event)"
          @click.stop
        />
        <span class="shrink-0 text-[10px] tabular-nums" data-testid="hover-video-time">
          {{ clock(currentTime) }} / {{ clock(duration) }}
        </span>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded hover:bg-white/20"
          :aria-label="muted ? '打开声音' : '静音'"
          data-testid="hover-video-mute"
          @click.stop="toggleMute()"
        >
          <VolumeX v-if="muted" class="size-3.5" />
          <Volume2 v-else class="size-3.5" />
        </button>
      </div>
    </template>
  </div>
</template>
