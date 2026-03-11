<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue"

interface Props {
  moveSpeed?: number
  defaultRotationX?: number
  defaultRotationY?: number
  defaultRotationZ?: number
  /** 底部限制角度（屏幕下方，度数），默认 30 度 */
  bottomLimitDegrees?: number
  /** 顶部限制角度（屏幕上方，度数），默认 0 表示不限制 */
  topLimitDegrees?: number
  /** 中间矩形颜色 */
  squareColor?: string
}

const props = withDefaults(defineProps<Props>(), {
  moveSpeed: 0.005,
  defaultRotationX: -0.10,
  defaultRotationY: 0,
  defaultRotationZ: 0,
  bottomLimitDegrees: 38,
  topLimitDegrees: 0,
  squareColor: "#e5e5e5"
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

// 球体旋转角度（固定，使用 props）
const rotationX = computed(() => props.defaultRotationX)
const rotationY = computed(() => props.defaultRotationY)
const rotationZ = computed(() => props.defaultRotationZ)

// 拖动点在球面上的位置（球坐标）
const pointTheta = ref(0) // 水平角度
const pointPhi = ref(Math.PI / 2) // 垂直角度（从顶部开始）

const isActive = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// 3D旋转函数
function rotatePoint(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number
) {
  // 绕 X 轴旋转
  let y1 = y * Math.cos(rx) - z * Math.sin(rx)
  let z1 = y * Math.sin(rx) + z * Math.cos(rx)
  let x1 = x

  // 绕 Y 轴旋转
  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry)
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry)
  let y2 = y1

  // 绕 Z 轴旋转
  let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz)
  let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz)
  let z3 = z2

  return { x: x3, y: y3, z: z3 }
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

// 计算旋转后的拖动点位置和深度缩放
const point = computed(() => {
  const r = sphereRadius.value
  const x3d = r * Math.sin(pointPhi.value) * Math.cos(pointTheta.value)
  const y3d = r * Math.cos(pointPhi.value)
  const z3d = r * Math.sin(pointPhi.value) * Math.sin(pointTheta.value)

  const rotated = rotatePoint(
    x3d,
    y3d,
    z3d,
    rotationX.value,
    rotationY.value,
    rotationZ.value
  )

  const projected = project3Dto2D(rotated.x, rotated.y, rotated.z)

  // 计算深度缩放因子
  const perspective = 400
  const depthScale = perspective / (perspective + rotated.z)

  return { ...projected, scale: depthScale, depth: rotated.z }
})

// 球体外轮廓 - 遍历整个球面，找投影后的外包络
const sphereOutline = computed(() => {
  const r = sphereRadius.value
  const rx = rotationX.value
  const ry = rotationY.value
  const rz = rotationZ.value

  // 遍历球面上的所有点，找到投影后的外包络
  const projectedPoints: { x: number; y: number; z: number }[] = []

  const latSteps = 36
  const lonSteps = 72

  for (let i = 0; i <= latSteps; i++) {
    const lat = (Math.PI * i) / latSteps
    for (let j = 0; j <= lonSteps; j++) {
      const lon = (Math.PI * 2 * j) / lonSteps

      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)

      const rotated = rotatePoint(x, y, z, rx, ry, rz)
      const projected = project3Dto2D(rotated.x, rotated.y, rotated.z)
      projectedPoints.push({ ...projected, z: rotated.z })
    }
  }

  const center = sphereCenter.value

  // 按角度分组，每组取最远的点
  const angleBuckets: Map<number, { x: number; y: number }> = new Map()
  const bucketCount = 72

  for (const p of projectedPoints) {
    const dx = p.x - center.x
    const dy = p.y - center.y
    const angle = Math.atan2(dy, dx)
    const dist = Math.sqrt(dx * dx + dy * dy)

    const bucketIndex = Math.floor(
      ((angle + Math.PI) / (2 * Math.PI)) * bucketCount
    )

    const existing = angleBuckets.get(bucketIndex)
    if (
      !existing ||
      dist >
        Math.sqrt((existing.x - center.x) ** 2 + (existing.y - center.y) ** 2)
    ) {
      angleBuckets.set(bucketIndex, { x: p.x, y: p.y })
    }
  }

  const outlinePoints: { x: number; y: number }[] = []
  for (let i = 0; i < bucketCount; i++) {
    const p = angleBuckets.get(i)
    if (p) outlinePoints.push(p)
  }

  if (outlinePoints.length > 0) {
    let path = "M " + outlinePoints[0].x + " " + outlinePoints[0].y
    for (let i = 1; i < outlinePoints.length; i++) {
      path += " L " + outlinePoints[i].x + " " + outlinePoints[i].y
    }
    path += " Z"
    return path
  }
  return ""
})

// 生成经纬度网格线
const latitudeLines = computed(() => {
  const lines: { path: string }[] = []
  const r = sphereRadius.value
  const latCount = 4

  for (let i = 1; i < latCount; i++) {
    const lat = (Math.PI * i) / latCount
    const points: { x: number; y: number; z: number }[] = []

    for (let j = 0; j <= 36; j++) {
      const lon = (Math.PI * 2 * j) / 36
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)

      const rotated = rotatePoint(
        x,
        y,
        z,
        rotationX.value,
        rotationY.value,
        rotationZ.value
      )
      points.push(rotated)
    }

    const projected = points.map((p) => project3Dto2D(p.x, p.y, p.z))

    if (projected.length > 0) {
      let path = "M " + projected[0].x + " " + projected[0].y
      for (let j = 1; j < projected.length; j++) {
        path += " L " + projected[j].x + " " + projected[j].y
      }
      lines.push({ path })
    }
  }

  return lines
})

const longitudeLines = computed(() => {
  const lines: { path: string }[] = []
  const r = sphereRadius.value
  const lonCount = 4

  for (let i = 0; i < lonCount; i++) {
    const lon = (Math.PI * 2 * i) / lonCount
    const points: { x: number; y: number; z: number }[] = []

    for (let j = 0; j <= 18; j++) {
      const lat = (Math.PI * j) / 18
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)

      const rotated = rotatePoint(
        x,
        y,
        z,
        rotationX.value,
        rotationY.value,
        rotationZ.value
      )
      points.push(rotated)
    }

    const projected = points.map((p) => project3Dto2D(p.x, p.y, p.z))

    if (projected.length > 0) {
      let path = "M " + projected[0].x + " " + projected[0].y
      for (let j = 1; j < projected.length; j++) {
        path += " L " + projected[j].x + " " + projected[j].y
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

// 内部矩形（面积为外部的 1/2，居中）
const innerRect = computed(() => {
  // 面积为一半，边长为 sqrt(1/2) ≈ 0.707
  const innerSize = squareSize.value * Math.sqrt(0.5)
  return {
    x: sphereCenter.value.x - innerSize / 2,
    y: sphereCenter.value.y - innerSize / 2,
    size: innerSize
  }
})

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

const pointStyle = computed(() => {
  const scaledRadius = pointRadius.value * point.value.scale
  // 根据深度调整透明度
  // depth > 0 表示在球体后方，应该更透明
  let opacity = Math.max(0.4, Math.min(1, 0.7 + point.value.scale * 0.3))
  if (point.value.depth > 0) {
    // 在后方时降低透明度
    opacity = Math.min(opacity, 0.5)
  }
  return {
    left: point.value.x - scaledRadius + "px",
    top: point.value.y - scaledRadius + "px",
    width: scaledRadius * 2 + "px",
    height: scaledRadius * 2 + "px",
    cursor: isActive.value ? "grabbing" : "pointer",
    opacity: opacity
  }
})

// 计算 phi 的限制范围（弧度）
// 注意：屏幕坐标中，phi 越小点越靠近屏幕底部
const phiLimits = computed(() => {
  // bottomLimitDegrees: 限制点不能太靠近屏幕底部（对应 phi 最小值）
  // topLimitDegrees: 限制点不能太靠近屏幕顶部（对应 phi 最大值）
  const minPhi = (props.bottomLimitDegrees * Math.PI) / 180
  const maxPhi = Math.PI - (props.topLimitDegrees * Math.PI) / 180
  return { min: minPhi, max: maxPhi }
})

function updateRotation(deltaX: number, deltaY: number) {
  const speed = props.moveSpeed

  // 更新点在球面上的位置
  pointTheta.value += deltaX * speed
  const newPhi = pointPhi.value - deltaY * speed

  // 限制 phi 在有效范围内
  pointPhi.value = Math.max(
    phiLimits.value.min,
    Math.min(phiLimits.value.max, newPhi)
  )

  emit("update:position", point.value)
  emit("update:spherical", { theta: pointTheta.value, phi: pointPhi.value })
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
      class="absolute border-2 border-primary/50 backdrop-blur-sm rounded-sm"
      :style="{
        left: squareOffset.x + 'px',
        top: squareOffset.y + 'px',
        width: squareSize + 'px',
        height: squareSize + 'px',
        backgroundColor: squareColor + '83'
      }"
    />

    <!-- SVG for sphere grid -->
    <svg
      class="absolute inset-0 pointer-events-none"
      :width="containerSize.width"
      :height="containerSize.height"
    >
      <!-- Sphere outline (球体外轮廓) -->
      <path
        :d="sphereOutline"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="text-primary/60"
      />

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

      <!-- Inner rectangle (center, half area) -->
      <rect
        :x="innerRect.x"
        :y="innerRect.y"
        :width="innerRect.size"
        :height="innerRect.size"
        fill="none"
        :stroke="props.squareColor"
        stroke-width="1"
        stroke-dasharray="4 2"
        opacity="0.5"
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
        :class="point.depth > 0 ? 'text-primary/30' : 'text-primary/60'"
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
