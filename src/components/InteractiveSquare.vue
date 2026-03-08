<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface Props {
  squareSize?: number
  dragAreaScale?: number
}

const props = withDefaults(defineProps<Props>(), {
  squareSize: 200,
  dragAreaScale: 1.5,
})

const emit = defineEmits<{
  (e: 'update:position', value: { x: number; y: number }): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const dragAreaSize = computed(() => Math.round(props.squareSize * props.dragAreaScale))
const squareOffset = computed(() => (dragAreaSize.value - props.squareSize) / 2)
const pointRadius = 12

const point = ref({ x: dragAreaSize.value / 2, y: dragAreaSize.value / 2 })
const isDragging = ref(false)

const corners = computed(() => [
  { x: squareOffset.value, y: squareOffset.value },
  { x: squareOffset.value + props.squareSize, y: squareOffset.value },
  { x: squareOffset.value, y: squareOffset.value + props.squareSize },
  { x: squareOffset.value + props.squareSize, y: squareOffset.value + props.squareSize },
])

const lines = computed(() =>
  corners.value.map((corner) => ({
    x1: corner.x,
    y1: corner.y,
    x2: point.value.x,
    y2: point.value.y,
  }))
)

const pointStyle = computed(() => ({
  left: `${point.value.x - pointRadius}px`,
  top: `${point.value.y - pointRadius}px`,
  cursor: isDragging.value ? 'grabbing' : 'grab',
}))

function handleMouseDown(e: MouseEvent) {
  isDragging.value = true
  e.preventDefault()
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging.value || !containerRef.value) return

  const rect = containerRef.value.getBoundingClientRect()
  let x = e.clientX - rect.left
  let y = e.clientY - rect.top

  x = Math.max(pointRadius, Math.min(dragAreaSize.value - pointRadius, x))
  y = Math.max(pointRadius, Math.min(dragAreaSize.value - pointRadius, y))

  point.value = { x, y }
  emit('update:position', { x, y })
}

function handleMouseUp() {
  isDragging.value = false
}

function handleTouchStart(e: TouchEvent) {
  isDragging.value = true
  e.preventDefault()
}

function handleTouchMove(e: TouchEvent) {
  if (!isDragging.value || !containerRef.value) return

  const touch = e.touches[0]
  if (!touch) return

  const rect = containerRef.value.getBoundingClientRect()
  let x = touch.clientX - rect.left
  let y = touch.clientY - rect.top

  x = Math.max(pointRadius, Math.min(dragAreaSize.value - pointRadius, x))
  y = Math.max(pointRadius, Math.min(dragAreaSize.value - pointRadius, y))

  point.value = { x, y }
  emit('update:position', { x, y })
}

function handleTouchEnd() {
  isDragging.value = false
}

onMounted(() => {
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative select-none"
    :style="{ width: `${dragAreaSize}px`, height: `${dragAreaSize}px` }"
    @mousedown="handleMouseDown"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  >
    <!-- Square boundary -->
    <div
      class="absolute border-2 border-primary bg-muted/30"
      :style="{
        left: `${squareOffset}px`,
        top: `${squareOffset}px`,
        width: `${squareSize}px`,
        height: `${squareSize}px`,
      }"
    />

    <!-- SVG for lines -->
    <svg
      class="absolute inset-0 pointer-events-none"
      :width="dragAreaSize"
      :height="dragAreaSize"
    >
      <!-- Center axis lines (dashed) -->
      <line
        :x1="squareOffset"
        :y1="squareOffset + squareSize / 2"
        :x2="squareOffset + squareSize"
        :y2="squareOffset + squareSize / 2"
        stroke="currentColor"
        stroke-width="1"
        stroke-dasharray="6 4"
        class="text-primary/40"
      />
      <line
        :x1="squareOffset + squareSize / 2"
        :y1="squareOffset"
        :x2="squareOffset + squareSize / 2"
        :y2="squareOffset + squareSize"
        stroke="currentColor"
        stroke-width="1"
        stroke-dasharray="6 4"
        class="text-primary/40"
      />
      <!-- Lines to corners -->
      <line
        v-for="(line, index) in lines"
        :key="index"
        :x1="line.x1"
        :y1="line.y1"
        :x2="line.x2"
        :y2="line.y2"
        stroke="currentColor"
        stroke-width="2"
        class="text-primary/60"
      />
    </svg>

    <!-- Corner markers -->
    <div
      v-for="(corner, index) in corners"
      :key="`corner-${index}`"
      class="absolute w-3 h-3 rounded-full bg-primary"
      :style="{ left: `${corner.x - 6}px`, top: `${corner.y - 6}px` }"
    />

    <!-- Draggable point -->
    <div
      class="absolute w-6 h-6 rounded-full bg-primary shadow-lg transition-transform"
      :class="{ 'scale-110': isDragging }"
      :style="pointStyle"
    />
  </div>
</template>