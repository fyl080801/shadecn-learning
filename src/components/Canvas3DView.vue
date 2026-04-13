<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue"

interface Props {
  width?: number
  height?: number
  moveSpeed?: number
  defaultRotationX?: number
  defaultRotationY?: number
  defaultRotationZ?: number
  bottomLimitDegrees?: number
  topLimitDegrees?: number
  squareColor?: string
  pointColor?: string
  lineColor?: string
  gridColor?: string
  outlineColor?: string
}

const props = withDefaults(defineProps<Props>(), {
  width: 300,
  height: 300,
  moveSpeed: 0.005,
  defaultRotationX: 0,
  defaultRotationY: 0,
  defaultRotationZ: 0,
  bottomLimitDegrees: 38,
  topLimitDegrees: 0,
  squareColor: "rgba(200,200,200,0.5)",
  pointColor: "#3b82f6",
  lineColor: "rgba(59,130,246,0.5)",
  gridColor: "rgba(59,130,246,0.25)",
  outlineColor: "rgba(59,130,246,0.6)"
})

const emit = defineEmits<{
  (e: "update:position", value: { x: number; y: number }): void
  (e: "update:spherical", value: { theta: number; phi: number }): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)

// 球面坐标
const pointTheta = ref(0)
const pointPhi = ref(Math.PI / 2)

const isActive = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// 尺寸计算
const squareSize = computed(() => Math.min(props.width, props.height) * 0.35)
const sphereRadius = computed(() => {
  const halfDiag = (squareSize.value * Math.sqrt(3)) / 2
  return halfDiag + squareSize.value * 0.25
})
const center = computed(() => ({ x: props.width / 2, y: props.height / 2 }))
const pointRadius = computed(() => squareSize.value * 0.08)

const phiLimits = computed(() => ({
  min: (props.bottomLimitDegrees * Math.PI) / 180,
  max: Math.PI - (props.topLimitDegrees * Math.PI) / 180
}))

// 3D 旋转
function rotatePoint(x: number, y: number, z: number, rx: number, ry: number, rz: number) {
  let y1 = y * Math.cos(rx) - z * Math.sin(rx)
  let z1 = y * Math.sin(rx) + z * Math.cos(rx)
  let x1 = x
  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry)
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry)
  let y2 = y1
  let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz)
  let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz)
  let z3 = z2
  return { x: x3, y: y3, z: z3 }
}

function project(x: number, y: number, z: number) {
  const perspective = 400
  const scale = perspective / (perspective + z)
  return { x: center.value.x + x * scale, y: center.value.y + y * scale, scale }
}

// 获取移动点的投影信息
function getPointProjection() {
  const r = sphereRadius.value
  const x3d = r * Math.sin(pointPhi.value) * Math.cos(pointTheta.value)
  const y3d = r * Math.cos(pointPhi.value)
  const z3d = r * Math.sin(pointPhi.value) * Math.sin(pointTheta.value)
  const rot = rotatePoint(x3d, y3d, z3d, props.defaultRotationX, props.defaultRotationY, props.defaultRotationZ)
  const proj = project(rot.x, rot.y, rot.z)
  return { x: proj.x, y: proj.y, scale: proj.scale, depth: rot.z }
}

// ============= 绘制 =============
function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  canvas.width = props.width * dpr
  canvas.height = props.height * dpr
  canvas.style.width = props.width + "px"
  canvas.style.height = props.height + "px"
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, props.width, props.height)

  const rx = props.defaultRotationX
  const ry = props.defaultRotationY
  const rz = props.defaultRotationZ
  const r = sphereRadius.value

  // 1. 球体外轮廓
  drawSphereOutline(ctx, r, rx, ry, rz)

  // 2. 经纬线
  drawGridLines(ctx, r, rx, ry, rz)

  // 3. 中心参照矩形
  drawSquare(ctx)

  // 4. 内部虚线矩形
  drawInnerRect(ctx)

  // 5. 角到拖动点的连线
  const pt = getPointProjection()
  drawCornerLines(ctx, pt)

  // 6. 角点标记
  drawCornerDots(ctx)

  // 7. 拖动点
  drawPoint(ctx, pt)
}

function drawSphereOutline(ctx: CanvasRenderingContext2D, r: number, rx: number, ry: number, rz: number) {
  // 透视投影解析法计算球体轮廓
  // 相机在 (0, 0, -d)，球心在原点，半径 r
  // 轮廓环是相机到球面切线的圆锥与球面的交线
  const d = 400 // perspective distance
  const cx = center.value.x
  const cy = center.value.y

  // 切线圆锥：轮廓环在球面上的 z 坐标为 zc = r²/d（相对球心）
  // 轮廓环半径 rc = r * sqrt(1 - (r/d)²)
  const zc = -(r * r) / d  // 球心在原点，相机在 -d，轮廓环偏向相机侧
  const rc = r * Math.sqrt(1 - (r * r) / (d * d))

  const steps = 120
  const outlinePoints: { x: number; y: number }[] = []

  for (let i = 0; i < steps; i++) {
    const angle = (Math.PI * 2 * i) / steps
    // 轮廓环上的3D点（旋转前）
    const px = rc * Math.cos(angle)
    const py = rc * Math.sin(angle)
    const pz = zc

    // 应用旋转
    const rot = rotatePoint(px, py, pz, rx, ry, rz)
    // 透视投影
    const scale = d / (d + rot.z)
    outlinePoints.push({
      x: cx + rot.x * scale,
      y: cy + rot.y * scale
    })
  }

  if (outlinePoints.length > 1) {
    ctx.beginPath()
    ctx.moveTo(outlinePoints[0]!.x, outlinePoints[0]!.y)
    for (let i = 1; i < outlinePoints.length; i++) {
      ctx.lineTo(outlinePoints[i]!.x, outlinePoints[i]!.y)
    }
    ctx.closePath()
    ctx.strokeStyle = props.outlineColor
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawGridLines(ctx: CanvasRenderingContext2D, r: number, rx: number, ry: number, rz: number) {
  ctx.strokeStyle = props.gridColor
  ctx.lineWidth = 1

  // 纬线: 赤道(0°) 及上下各30°
  const latitudes = [
    Math.PI / 4,       // +30° (上方)
    Math.PI / 2,       // 0°  赤道(中心)
    (Math.PI * 2) / 3  // -30° (下方)
  ]
  for (const lat of latitudes) {
    ctx.beginPath()
    for (let j = 0; j <= 36; j++) {
      const lon = (Math.PI * 2 * j) / 36
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)
      const rot = rotatePoint(x, y, z, rx, ry, rz)
      const proj = project(rot.x, rot.y, rot.z)
      if (j === 0) ctx.moveTo(proj.x, proj.y)
      else ctx.lineTo(proj.x, proj.y)
    }
    ctx.stroke()
  }

  // 中心经线 — lon = -π/2 (正前方)，从北极到南极的竖直半圆
  const centerLon = -Math.PI / 2
  ctx.beginPath()
  for (let j = 0; j <= 36; j++) {
    const lat = (Math.PI * j) / 36
    const x = r * Math.sin(lat) * Math.cos(centerLon)
    const y = r * Math.cos(lat)
    const z = r * Math.sin(lat) * Math.sin(centerLon)
    const rot = rotatePoint(x, y, z, rx, ry, rz)
    const proj = project(rot.x, rot.y, rot.z)
    if (j === 0) ctx.moveTo(proj.x, proj.y)
    else ctx.lineTo(proj.x, proj.y)
  }
  ctx.stroke()
}

function drawSquare(ctx: CanvasRenderingContext2D) {
  const s = squareSize.value
  const ox = center.value.x - s / 2
  const oy = center.value.y - s / 2
  ctx.fillStyle = props.squareColor
  ctx.strokeStyle = "rgba(100,100,100,0.5)"
  ctx.lineWidth = 2
  ctx.fillRect(ox, oy, s, s)
  ctx.strokeRect(ox, oy, s, s)
}

function drawInnerRect(ctx: CanvasRenderingContext2D) {
  const innerSize = squareSize.value * Math.sqrt(0.5)
  const ix = center.value.x - innerSize / 2
  const iy = center.value.y - innerSize / 2
  ctx.setLineDash([4, 2])
  ctx.strokeStyle = "rgba(150,150,150,0.5)"
  ctx.lineWidth = 1
  ctx.strokeRect(ix, iy, innerSize, innerSize)
  ctx.setLineDash([])
}

function drawCornerLines(ctx: CanvasRenderingContext2D, pt: { x: number; y: number; depth: number }) {
  const s = squareSize.value
  const ox = center.value.x - s / 2
  const oy = center.value.y - s / 2
  const corners = [
    { x: ox, y: oy },
    { x: ox + s, y: oy },
    { x: ox, y: oy + s },
    { x: ox + s, y: oy + s }
  ]
  ctx.strokeStyle = pt.depth > 0 ? "rgba(59,130,246,0.2)" : props.lineColor
  ctx.lineWidth = 2
  for (const c of corners) {
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
  }
}

function drawCornerDots(ctx: CanvasRenderingContext2D) {
  const s = squareSize.value
  const ox = center.value.x - s / 2
  const oy = center.value.y - s / 2
  const corners = [
    { x: ox, y: oy },
    { x: ox + s, y: oy },
    { x: ox, y: oy + s },
    { x: ox + s, y: oy + s }
  ]
  ctx.fillStyle = props.pointColor
  for (const c of corners) {
    ctx.beginPath()
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawPoint(ctx: CanvasRenderingContext2D, pt: { x: number; y: number; scale: number; depth: number }) {
  const scaledR = pointRadius.value * pt.scale
  let opacity = Math.max(0.4, Math.min(1, 0.7 + pt.scale * 0.3))
  if (pt.depth > 0) opacity = Math.min(opacity, 0.5)

  ctx.save()
  ctx.globalAlpha = opacity
  ctx.fillStyle = props.pointColor

  // 阴影
  ctx.shadowColor = "rgba(0,0,0,0.3)"
  ctx.shadowBlur = 8
  ctx.shadowOffsetX = 2
  ctx.shadowOffsetY = 2

  ctx.beginPath()
  ctx.arc(pt.x, pt.y, scaledR, 0, Math.PI * 2)
  ctx.fill()

  // active 状态外圈
  if (isActive.value) {
    ctx.shadowColor = "transparent"
    ctx.strokeStyle = props.pointColor
    ctx.lineWidth = 2
    ctx.globalAlpha = opacity * 0.5
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, scaledR + 4, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()
}

// ============= 交互 =============
function updateRotation(deltaX: number, deltaY: number) {
  pointTheta.value += deltaX * props.moveSpeed
  const newPhi = pointPhi.value - deltaY * props.moveSpeed
  pointPhi.value = Math.max(phiLimits.value.min, Math.min(phiLimits.value.max, newPhi))
  const pt = getPointProjection()
  emit("update:position", { x: pt.x, y: pt.y })
  emit("update:spherical", { theta: pointTheta.value, phi: pointPhi.value })
  draw()
}

function getEventPos(e: MouseEvent | Touch) {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function isOnPoint(ex: number, ey: number) {
  const pt = getPointProjection()
  const scaledR = pointRadius.value * pt.scale
  const dx = ex - pt.x, dy = ey - pt.y
  return dx * dx + dy * dy <= (scaledR + 10) ** 2
}

function handleMouseDown(e: MouseEvent) {
  const pos = getEventPos(e)
  if (isOnPoint(pos.x, pos.y)) {
    isActive.value = true
    dragStart.value = { x: e.clientX, y: e.clientY }
    e.preventDefault()
    draw()
  }
}

function handleMouseMove(e: MouseEvent) {
  if (!isActive.value) return
  const dx = e.clientX - dragStart.value.x
  const dy = e.clientY - dragStart.value.y
  dragStart.value = { x: e.clientX, y: e.clientY }
  updateRotation(dx, dy)
}

function handleMouseUp() {
  if (isActive.value) {
    isActive.value = false
    draw()
  }
}

function handleTouchStart(e: TouchEvent) {
  const touch = e.touches[0]
  if (!touch) return
  const pos = getEventPos(touch)
  if (isOnPoint(pos.x, pos.y)) {
    isActive.value = true
    dragStart.value = { x: touch.clientX, y: touch.clientY }
    e.preventDefault()
    draw()
  }
}

function handleTouchMove(e: TouchEvent) {
  if (!isActive.value) return
  const touch = e.touches[0]
  if (!touch) return
  const dx = touch.clientX - dragStart.value.x
  const dy = touch.clientY - dragStart.value.y
  dragStart.value = { x: touch.clientX, y: touch.clientY }
  updateRotation(dx, dy)
  e.preventDefault()
}

function handleTouchEnd() {
  if (isActive.value) {
    isActive.value = false
    draw()
  }
}

// 响应 props 变化重绘
watch(() => [props.width, props.height, props.defaultRotationX, props.defaultRotationY, props.defaultRotationZ, props.squareColor, props.pointColor], () => {
  draw()
})

onMounted(() => {
  draw()
  window.addEventListener("mousemove", handleMouseMove)
  window.addEventListener("mouseup", handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener("mousemove", handleMouseMove)
  window.removeEventListener("mouseup", handleMouseUp)
})
</script>

<template>
  <canvas
    ref="canvasRef"
    :style="{ width: width + 'px', height: height + 'px', cursor: isActive ? 'grabbing' : 'default' }"
    @mousedown="handleMouseDown"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  />
</template>