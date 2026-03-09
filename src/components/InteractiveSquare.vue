<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue"

interface Props {
  moveSpeed?: number
}

const props = withDefaults(defineProps<Props>(), {
  moveSpeed: 0.005
})

const emit = defineEmits<{
  (e: "update:position", value: { x: number; y: number }): void
  (e: "update:spherical", value: { theta: number; phi: number }): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const containerSize = ref({ width: 300, height: 300 })

const squareSize = computed(
  () => Math.min(containerSize.value.width, containerSize.value.height) * 0.35
)
const sphereRadius = computed(() => {
  const halfDiagonal = (squareSize.value * Math.sqrt(3)) / 2
  return halfDiagonal + squareSize.value * 0.25
})
const sphereCenter = computed(() => ({
  x: containerSize.value.width / 2,
  y: containerSize.value.height / 2
}))

const pointRadius = computed(() => squareSize.value * 0.08)

// 球体旋转角度
const rotationX = ref(0)
const rotationY = ref(0)

// 拖动点位置（固定在球体前方）
const pointPhi = ref(Math.PI / 2)

const isActive = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// 3D旋转函数
function rotatePoint(x: number, y: number, z: number, rx: number, ry: number) {
  let y1 = y * Math.cos(rx) - z * Math.sin(rx)
  let z1 = y * Math.sin(rx) + z * Math.cos(rx)
  let x1 = x

  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry)
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry)

  return { x: x2, y: y1, z: z2 }
}

function project3Dto2D(x: number, y: number, z: number) {
  const center = sphereCenter.value
  const perspective = 400
  const scale = perspective / (perspective + z)

  return {
    x: center.x + x * scale,
    y: center.y + y * scale
  }
}

// 计算旋转后的拖动点位置
const point = computed(() => {
  const r = sphereRadius.value
  const x3d = 0
  const y3d = r * Math.cos(pointPhi.value)
  const z3d = r * Math.sin(pointPhi.value)

  const rotated = rotatePoint(x3d, y3d, z3d, rotationX.value, rotationY.value)

  return project3Dto2D(rotated.x, rotated.y, rotated.z)
})

// 生成经纬度网格线
const latitudeLines = computed(() => {
  const lines: { path: string }[] = []
  const r = sphereRadius.value
  const latCount = 7

  for (let i = 1; i < latCount; i++) {
    const lat = (Math.PI * i) / latCount
    const points: { x: number; y: number; z: number }[] = []

    for (let j = 0; j <= 36; j++) {
      const lon = (Math.PI * 2 * j) / 36
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)

      const rotated = rotatePoint(x, y, z, rotationX.value, rotationY.value)
      points.push(rotated)
    }

    const projected = points.map((p) => project3Dto2D(p.x, p.y, p.z))

    if (projected.length > 0) {
      let path = "M " + projected?.[0]?.x + " " + projected?.[0]?.y
      for (let j = 1; j < projected.length; j++) {
        path += " L " + projected?.[j]?.x + " " + projected?.[j]?.y
      }
      lines.push({ path })
    }
  }

  return lines
})

const longitudeLines = computed(() => {
  const lines: { path: string }[] = []
  const r = sphereRadius.value
  const lonCount = 12

  for (let i = 0; i < lonCount; i++) {
    const lon = (Math.PI * 2 * i) / lonCount
    const points: { x: number; y: number; z: number }[] = []

    for (let j = 0; j <= 18; j++) {
      const lat = (Math.PI * j) / 18
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)

      const rotated = rotatePoint(x, y, z, rotationX.value, rotationY.value)
      points.push(rotated)
    }

    const projected = points.map((p) => project3Dto2D(p.x, p.y, p.z))

    if (projected.length > 0) {
      let path = "M " + projected?.[0]?.x + " " + projected?.[0]?.y
      for (let j = 1; j < projected.length; j++) {
        path += " L " + projected?.[j]?.x + " " + projected?.[j]?.y
      }
      lines.push({ path })
    }
  }

  return lines
})

const squareOffset = computed(() => ({
  x: sphereCenter.value.x - squareSize.value / 2,
  y: sphereCenter.value.y - squareSize.value / 2
}))

const corners = computed(() => [
  { x: squareOffset.value.x, y: squareOffset.value.y },
  { x: squareOffset.value.x + squareSize.value, y: squareOffset.value.y },
  { x: squareOffset.value.x, y: squareOffset.value.y + squareSize.value },
  {
    x: squareOffset.value.x + squareSize.value,
    y: squareOffset.value.y + squareSize.value
  }
])

const lines = computed(() =>
  corners.value.map((corner) => ({
    x1: corner.x,
    y1: corner.y,
    x2: point.value.x,
    y2: point.value.y
  }))
)

const pointStyle = computed(() => ({
  left: point.value.x - pointRadius.value + "px",
  top: point.value.y - pointRadius.value + "px",
  width: pointRadius.value * 2 + "px",
  height: pointRadius.value * 2 + "px",
  cursor: isActive.value ? "grabbing" : "pointer"
}))

function updateRotation(deltaX: number, deltaY: number) {
  const speed = props.moveSpeed

  rotationY.value += deltaX * speed
  rotationX.value += deltaY * speed

  emit("update:position", point.value)
  emit("update:spherical", { theta: rotationY.value, phi: rotationX.value })
}

function handleMouseDown(e: MouseEvent) {
  isActive.value = true
  dragStart.value = { x: e.clientX, y: e.clientY }
  e.preventDefault()
}

function handleMouseMove(e: MouseEvent) {
  if (!isActive.value) return

  const deltaX = e.clientX - dragStart.value.x
  const deltaY = e.clientY - dragStart.value.y

  dragStart.value.x = e.clientX
  dragStart.value.y = e.clientY

  updateRotation(deltaX, deltaY)
}

function handleMouseUp() {
  isActive.value = false
}

function handleTouchStart(e: TouchEvent) {
  isActive.value = true
  const touch = e.touches[0]
  if (touch) {
    dragStart.value = { x: touch.clientX, y: touch.clientY }
  }
  e.preventDefault()
}

function handleTouchMove(e: TouchEvent) {
  if (!isActive.value) return

  const touch = e.touches[0]
  if (!touch) return

  const deltaX = touch.clientX - dragStart.value.x
  const deltaY = touch.clientY - dragStart.value.y

  dragStart.value.x = touch.clientX
  dragStart.value.y = touch.clientY

  updateRotation(deltaX, deltaY)
  e.preventDefault()
}

function handleTouchEnd() {
  isActive.value = false
}

function updateContainerSize() {
  if (containerRef.value) {
    containerSize.value = {
      width: containerRef.value.offsetWidth,
      height: containerRef.value.offsetHeight
    }
  }
}

onMounted(() => {
  updateContainerSize()
  window.addEventListener("resize", updateContainerSize)
  window.addEventListener("mousemove", handleMouseMove)
  window.addEventListener("mouseup", handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener("resize", updateContainerSize)
  window.removeEventListener("mousemove", handleMouseMove)
  window.removeEventListener("mouseup", handleMouseUp)
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative select-none"
    @mousedown="handleMouseDown"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  >
    <!-- Square boundary -->
    <div
      class="absolute border-2 border-primary bg-muted/30"
      :style="{
        left: squareOffset.x + 'px',
        top: squareOffset.y + 'px',
        width: squareSize + 'px',
        height: squareSize + 'px'
      }"
    />

    <!-- SVG for sphere grid -->
    <svg
      class="absolute inset-0 pointer-events-none"
      :width="containerSize.width"
      :height="containerSize.height"
    >
      <!-- Longitude lines (经线) -->
      <path
        v-for="(line, index) in longitudeLines"
        :key="'lon-' + index"
        :d="line.path"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        class="text-primary/40"
      />

      <!-- Latitude lines (纬线) -->
      <path
        v-for="(line, index) in latitudeLines"
        :key="'lat-' + index"
        :d="line.path"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        class="text-primary/40"
      />

      <!-- Center axis lines -->
      <line
        :x1="squareOffset.x"
        :y1="squareOffset.y + squareSize / 2"
        :x2="squareOffset.x + squareSize"
        :y2="squareOffset.y + squareSize / 2"
        stroke="currentColor"
        stroke-width="1"
        stroke-dasharray="6 4"
        class="text-primary/40"
      />
      <line
        :x1="squareOffset.x + squareSize / 2"
        :y1="squareOffset.y"
        :x2="squareOffset.x + squareSize / 2"
        :y2="squareOffset.y + squareSize"
        stroke="currentColor"
        stroke-width="1"
        stroke-dasharray="6 4"
        class="text-primary/40"
      />

      <!-- Lines to corners -->
      <line
        v-for="(line, index) in lines"
        :key="'corner-line-' + index"
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
      :key="'corner-' + index"
      class="absolute rounded-full bg-primary"
      :style="{
        left: corner.x - 4 + 'px',
        top: corner.y - 4 + 'px',
        width: '8px',
        height: '8px'
      }"
    />

    <!-- Draggable point -->
    <div
      class="absolute rounded-full bg-primary shadow-lg transition-transform"
      :class="{ 'scale-110': isActive }"
      :style="pointStyle"
    />
  </div>
</template>
