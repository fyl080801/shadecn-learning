<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Props {
  size?: number
  initialRotateX?: number
  initialRotateY?: number
  noBackSide?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 200,
  initialRotateX: -30,
  initialRotateY: 45,
  noBackSide: false,
})

const emit = defineEmits<{
  (e: 'update:rotation', value: { x: number; y: number }): void
}>()

const halfSize = props.size / 2
const rotateX = ref(props.initialRotateX)
const rotateY = ref(props.initialRotateY)
const isDragging = ref(false)
const lastX = ref(0)
const lastY = ref(0)

function handleMouseDown(e: MouseEvent) {
  isDragging.value = true
  lastX.value = e.clientX
  lastY.value = e.clientY
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging.value) return

  const deltaX = e.clientX - lastX.value
  const deltaY = e.clientY - lastY.value

  rotateY.value += deltaX * 0.5
  rotateX.value -= deltaY * 0.5

  // Limit rotation to prevent back side
  if (props.noBackSide) {
    rotateY.value = Math.max(-90, Math.min(90, rotateY.value))
    rotateX.value = Math.max(-90, Math.min(90, rotateX.value))
  }

  lastX.value = e.clientX
  lastY.value = e.clientY

  emit('update:rotation', { x: rotateX.value, y: rotateY.value })
}

function handleMouseUp() {
  isDragging.value = false
}

function handleTouchStart(e: TouchEvent) {
  const touch = e.touches[0]
  if (!touch) return
  isDragging.value = true
  lastX.value = touch.clientX
  lastY.value = touch.clientY
}

function handleTouchMove(e: TouchEvent) {
  if (!isDragging.value) return

  const touch = e.touches[0]
  if (!touch) return

  const deltaX = touch.clientX - lastX.value
  const deltaY = touch.clientY - lastY.value

  rotateY.value += deltaX * 0.5
  rotateX.value -= deltaY * 0.5

  // Limit rotation to prevent back side
  if (props.noBackSide) {
    rotateY.value = Math.max(-90, Math.min(90, rotateY.value))
    rotateX.value = Math.max(-90, Math.min(90, rotateX.value))
  }

  lastX.value = touch.clientX
  lastY.value = touch.clientY

  emit('update:rotation', { x: rotateX.value, y: rotateY.value })
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
    class="relative cursor-grab active:cursor-grabbing select-none"
    :class="{ 'cursor-grabbing': isDragging }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    @mousedown="handleMouseDown"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  >
    <div
      class="absolute w-full h-full"
      :style="{
        transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`,
        transformStyle: 'preserve-3d',
        transition: isDragging ? 'none' : 'transform 0.1s ease-out',
      }"
    >
      <!-- Front -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `translateZ(${halfSize}px)`,
        }"
      >
        <slot name="front">Front</slot>
      </div>
      <!-- Back -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `rotateY(180deg) translateZ(${halfSize}px)`,
        }"
      >
        <slot name="back">Back</slot>
      </div>
      <!-- Left -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `rotateY(-90deg) translateZ(${halfSize}px)`,
        }"
      >
        <slot name="left">Left</slot>
      </div>
      <!-- Right -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `rotateY(90deg) translateZ(${halfSize}px)`,
        }"
      >
        <slot name="right">Right</slot>
      </div>
      <!-- Top -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `rotateX(90deg) translateZ(${halfSize}px)`,
        }"
      >
        <slot name="top">Top</slot>
      </div>
      <!-- Bottom -->
      <div
        class="absolute border-2 border-black bg-gray-400 flex items-center justify-center text-gray-900 font-bold text-xl"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          transform: `rotateX(-90deg) translateZ(${halfSize}px)`,
        }"
      >
        <slot name="bottom">Bottom</slot>
      </div>
    </div>
  </div>
</template>