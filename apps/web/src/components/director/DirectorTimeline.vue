<script setup lang="ts">
import { computed, ref } from "vue"
import { Diamond, Pause, Play, Repeat } from "@lucide/vue"
import {
  DIRECTOR_KIND_LABELS,
  type DirectorKeyframe,
  type DirectorScene,
  type DirectorTrackProperty
} from "@shadecn/shared/director-doc"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * 导演台的最小时间轴（docs/07 §7.6）：按对象列轨道与关键帧、播放头、播放 / 暂停、循环、在播放头处打关键帧。
 *
 * 只是视图：播放状态归 `useDirectorPlayback`（本地），写入由父组件经导演台 ops 做。拖播放头、点关键帧都只发事件。
 * 不做关键帧拖动、曲线编辑（复杂的编排交给 agent）。
 */
const props = defineProps<{
  scene: DirectorScene
  /** 播放头，毫秒 */
  playhead: number
  playing: boolean
  loop: boolean
  selectedObjectId: string | null
  selectedKeyframeId: string | null
  /** 「打关键帧」能不能点（选中了对象） */
  canKeyframe: boolean
  keyframing?: boolean
}>()

const emit = defineEmits<{
  (e: "toggle"): void
  (e: "toggle-loop"): void
  (e: "seek", ms: number): void
  (e: "select-object", id: string): void
  (e: "select-keyframe", keyframe: DirectorKeyframe): void
  (e: "keyframe"): void
}>()

const PROPERTY_LABELS: Record<DirectorTrackProperty, string> = {
  position: "位置",
  rotation: "旋转",
  scale: "缩放",
  fov: "视场角"
}
const PROPERTY_COLORS: Record<DirectorTrackProperty, string> = {
  position: "bg-sky-500",
  rotation: "bg-amber-500",
  scale: "bg-emerald-500",
  fov: "bg-fuchsia-500"
}

interface TrackRow {
  id: string
  property: DirectorTrackProperty
  keyframes: DirectorKeyframe[]
}
interface ObjectRow {
  id: string
  name: string
  kind: string
  active: boolean
  tracks: TrackRow[]
}

const rows = computed<ObjectRow[]>(() => {
  const byTrack = new Map<string, DirectorKeyframe[]>()
  for (const keyframe of props.scene.keyframes.values()) {
    const list = byTrack.get(keyframe.trackId) ?? []
    list.push(keyframe)
    byTrack.set(keyframe.trackId, list)
  }
  const byObject = new Map<string, TrackRow[]>()
  for (const track of props.scene.tracks.values()) {
    const list = byObject.get(track.objectId) ?? []
    list.push({ id: track.id, property: track.property, keyframes: byTrack.get(track.id) ?? [] })
    byObject.set(track.objectId, list)
  }
  const order: DirectorTrackProperty[] = ["position", "rotation", "scale", "fov"]
  return [...props.scene.objects.values()]
    .map((object) => ({
      id: object.id,
      name: object.name || DIRECTOR_KIND_LABELS[object.kind],
      kind: DIRECTOR_KIND_LABELS[object.kind],
      active: props.scene.activeShot === object.id,
      tracks: (byObject.get(object.id) ?? []).sort((a, b) => order.indexOf(a.property) - order.indexOf(b.property))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id))
})

const duration = computed(() => Math.max(1, props.scene.duration))
const percentOf = (ms: number) => `${Math.min(100, Math.max(0, (ms / duration.value) * 100))}%`

/** 秒，两位小数 */
const seconds = (ms: number) => (ms / 1000).toFixed(2)

/** 标尺刻度：每秒一格，太长时放宽 */
const ticks = computed(() => {
  const total = duration.value / 1000
  const step = total <= 10 ? 1 : total <= 60 ? 5 : 30
  const out: number[] = []
  for (let s = 0; s <= total + 1e-9; s += step) out.push(s * 1000)
  return out
})

// —— 拖播放头 ——

const ruler = ref<HTMLElement | null>(null)
let scrubbing = false

function msAt(clientX: number): number {
  const rect = ruler.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return props.playhead
  const ratio = (clientX - rect.left) / rect.width
  return Math.min(1, Math.max(0, ratio)) * duration.value
}

function onScrubStart(event: PointerEvent) {
  if (event.button !== 0) return
  scrubbing = true
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  emit("seek", msAt(event.clientX))
}
function onScrubMove(event: PointerEvent) {
  if (scrubbing) emit("seek", msAt(event.clientX))
}
function onScrubEnd(event: PointerEvent) {
  scrubbing = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}
</script>

<template>
  <section class="flex h-52 shrink-0 flex-col border-t bg-card text-card-foreground" data-testid="director-timeline">
    <div class="flex items-center gap-1 border-b px-3 py-1.5">
      <Button
        variant="ghost"
        size="icon-xs"
        :aria-label="playing ? '暂停' : '播放'"
        data-testid="director-play"
        @click="emit('toggle')"
      >
        <Pause v-if="playing" />
        <Play v-else />
      </Button>
      <Button
        :variant="loop ? 'secondary' : 'ghost'"
        size="icon-xs"
        aria-label="循环播放"
        :aria-pressed="loop"
        data-testid="director-loop"
        @click="emit('toggle-loop')"
      >
        <Repeat />
      </Button>
      <span class="ml-1 text-xs tabular-nums text-muted-foreground" data-testid="director-time">
        {{ seconds(playhead) }}s / {{ seconds(scene.duration) }}s
      </span>
      <div class="flex-1" />
      <Button
        variant="outline"
        size="xs"
        :disabled="!canKeyframe"
        :loading="keyframing"
        data-testid="director-keyframe"
        @click="emit('keyframe')"
      >
        <Diamond />
        在播放头处打关键帧
      </Button>
    </div>

    <div class="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <!-- 标尺：拖它（或任一轨道的空白处）移动播放头 -->
      <div class="sticky top-0 z-10 grid grid-cols-[11rem_1fr] border-b bg-card">
        <div class="border-r px-3 py-1 text-[11px] text-muted-foreground">对象</div>
        <div
          ref="ruler"
          class="relative h-6 cursor-ew-resize select-none"
          data-testid="director-ruler"
          @pointerdown="onScrubStart"
          @pointermove="onScrubMove"
          @pointerup="onScrubEnd"
          @pointercancel="onScrubEnd"
        >
          <span
            v-for="tick in ticks"
            :key="tick"
            class="absolute top-0 h-full border-l border-border pl-1 text-[10px] leading-6 text-muted-foreground"
            :style="{ left: percentOf(tick) }"
          >{{ tick / 1000 }}s</span>
        </div>
      </div>

      <p v-if="rows.length === 0" class="px-3 py-4 text-xs text-muted-foreground">
        场景里还没有对象。用左上角「添加」放一个图形。
      </p>

      <div class="relative">
        <template v-for="row in rows" :key="row.id">
          <div
            class="grid grid-cols-[11rem_1fr] border-b border-border/50"
            :class="row.id === selectedObjectId && 'bg-accent/60'"
            data-role="object-row"
            :data-object-id="row.id"
          >
            <button
              type="button"
              class="truncate border-r px-3 py-1 text-left text-xs"
              :title="`${row.name}（${row.kind}）`"
              @click="emit('select-object', row.id)"
            >
              <span v-if="row.active" class="mr-1 text-primary" title="当前机位">●</span>{{ row.name }}
            </button>
            <div
              class="relative h-6"
              @pointerdown="onScrubStart"
              @pointermove="onScrubMove"
              @pointerup="onScrubEnd"
              @pointercancel="onScrubEnd"
            />
          </div>
          <div
            v-for="track in row.tracks"
            :key="track.id"
            class="grid grid-cols-[11rem_1fr] border-b border-border/30"
            data-role="track-row"
            :data-track-id="track.id"
          >
            <div class="truncate border-r py-0.5 pl-6 pr-3 text-[11px] text-muted-foreground">
              {{ PROPERTY_LABELS[track.property] }}
            </div>
            <div
              class="relative h-5"
              @pointerdown="onScrubStart"
              @pointermove="onScrubMove"
              @pointerup="onScrubEnd"
              @pointercancel="onScrubEnd"
            >
              <button
                v-for="keyframe in track.keyframes"
                :key="keyframe.id"
                type="button"
                :class="cn(
                  'absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-offset-1',
                  PROPERTY_COLORS[track.property],
                  keyframe.id === selectedKeyframeId && 'ring-2 ring-foreground'
                )"
                :style="{ left: percentOf(keyframe.t) }"
                :aria-label="`${PROPERTY_LABELS[track.property]} 关键帧 ${seconds(keyframe.t)}s`"
                data-role="keyframe"
                :data-keyframe-id="keyframe.id"
                @pointerdown.stop
                @click="emit('select-keyframe', keyframe)"
              />
            </div>
          </div>
        </template>

        <!-- 播放头：只盖在轨道列上 -->
        <div
          class="pointer-events-none absolute inset-y-0 left-44 right-0"
          aria-hidden="true"
        >
          <div class="absolute inset-y-0 w-px bg-primary" :style="{ left: percentOf(playhead) }" data-testid="director-playhead" />
        </div>
      </div>
    </div>
  </section>
</template>
