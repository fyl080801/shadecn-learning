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
  darkMode?: boolean
  modelValue?: {
    yaw: number
    pitch: number
    zoomLevel: "in" | "out" | "unchanged"
  }
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
  outlineColor: "rgba(59,130,246,0.6)",
  darkMode: false,
  modelValue: () => ({ yaw: 0, pitch: 0, zoomLevel: "unchanged" as const })
})

// 暗色模式下的颜色计算
const colors = computed(() => {
  if (props.darkMode) {
    return {
      squareColor: "rgba(255,255,255,0.08)",
      squareStroke: "rgba(255,255,255,0.5)",
      pointColor: "#ffffff",
      lineColor: "rgba(255,255,255,0.5)",
      gridFront: "rgba(255,255,255,0.35)",
      gridBack: "rgba(255,255,255,0.1)",
      outlineColor: "rgba(255,255,255,0.6)",
      innerRectStroke: "rgba(255,255,255,0.4)",
      cornerLineBehind: "rgba(255,255,255,0.2)",
      camFrontFill: "rgba(255,255,255,0.1)",
      camBackFill: "rgba(255,255,255,0.05)",
      camBackStroke: "rgba(255,255,255,0.3)",
      camSideStroke: "rgba(255,255,255,0.35)",
      camLensStroke: "rgba(255,255,255,0.6)",
      bgColor: "#0f172a"
    }
  }
  return {
    squareColor: props.squareColor,
    squareStroke: "rgba(100,100,100,0.5)",
    pointColor: props.pointColor,
    lineColor: props.lineColor,
    gridFront: props.gridColor,
    gridBack: props.gridColor.replace(/[\d.]+\)$/, "0.1)"),
    outlineColor: props.outlineColor,
    innerRectStroke: "rgba(150,150,150,0.5)",
    cornerLineBehind: "rgba(59,130,246,0.2)",
    camFrontFill: "rgba(59,130,246,0.15)",
    camBackFill: "rgba(59,130,246,0.08)",
    camBackStroke: "rgba(59,130,246,0.3)",
    camSideStroke: "rgba(59,130,246,0.35)",
    camLensStroke: "rgba(59,130,246,0.6)",
    bgColor: "transparent"
  }
})

const emit = defineEmits<{
  (
    e: "update:modelValue",
    value: { yaw: number; pitch: number; zoomLevel: "in" | "out" | "unchanged" }
  ): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)

// 球面坐标
const pointTheta = ref(0)
const pointPhi = ref(Math.PI / 2)
const internalZoomLevel = ref<"in" | "out" | "unchanged">("unchanged")

const isActive = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// 尺寸计算
const baseSize = computed(() => Math.min(props.width, props.height) * 0.35)
const zoomScale = computed(() => {
  switch (internalZoomLevel.value) {
    case "in":
      return 1.35
    case "out":
      return 0.7
    default:
      return 1.0
  }
})
const squareSize = computed(() => baseSize.value * zoomScale.value)
const sphereRadius = computed(() => {
  const halfDiag = (baseSize.value * Math.sqrt(3)) / 2
  return halfDiag + baseSize.value * 0.25
})
const center = computed(() => ({ x: props.width / 2, y: props.height / 2 }))

const phiLimits = computed(() => ({
  min: (props.bottomLimitDegrees * Math.PI) / 180,
  max: Math.PI - (props.topLimitDegrees * Math.PI) / 180
}))

// 同步 v-model 到内部球面坐标
watch(
  () => props.modelValue,
  (val) => {
    pointTheta.value = (val.yaw * Math.PI) / 180
    pointPhi.value = Math.PI / 2 - (val.pitch * Math.PI) / 180
    internalZoomLevel.value = val.zoomLevel ?? "unchanged"
    draw()
  },
  { immediate: true }
)

// 3D 旋转
function rotatePoint(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number
) {
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

// 获取移动点的投影信息（浮于球面上方）
function getPointProjection() {
  const r = sphereRadius.value
  const lift = baseSize.value * 0.08
  const factor = 1 + lift / r
  // theta=0 时点朝向屏幕前方（z负方向），偏移 -π/2
  const x3d = r * Math.sin(pointPhi.value) * Math.sin(pointTheta.value) * factor
  const y3d = r * Math.cos(pointPhi.value) * factor
  const z3d = -r * Math.sin(pointPhi.value) * Math.cos(pointTheta.value) * factor
  const rot = rotatePoint(
    x3d,
    y3d,
    z3d,
    props.defaultRotationX,
    props.defaultRotationY,
    props.defaultRotationZ
  )
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

  // 暗色模式填充背景
  if (props.darkMode) {
    ctx.fillStyle = colors.value.bgColor
    ctx.fillRect(0, 0, props.width, props.height)
  }

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

function drawSphereOutline(
  ctx: CanvasRenderingContext2D,
  r: number,
  rx: number,
  ry: number,
  rz: number
) {
  // 透视投影解析法计算球体轮廓
  // 相机在 (0, 0, -d)，球心在原点，半径 r
  // 轮廓环是相机到球面切线的圆锥与球面的交线
  const d = 400 // perspective distance
  const cx = center.value.x
  const cy = center.value.y

  // 切线圆锥：轮廓环在球面上的 z 坐标为 zc = r²/d（相对球心）
  // 轮廓环半径 rc = r * sqrt(1 - (r/d)²)
  const zc = -(r * r) / d // 球心在原点，相机在 -d，轮廓环偏向相机侧
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
    ctx.strokeStyle = colors.value.outlineColor
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  r: number,
  rx: number,
  ry: number,
  rz: number
) {
  const frontColor = colors.value.gridFront
  const backColor = colors.value.gridBack

  // 绘制一条纬线（完整环，自动区分前后）
  function drawLatLine(lat: number) {
    const points: { x: number; y: number; behind: boolean }[] = []
    for (let j = 0; j <= 72; j++) {
      const lon = (Math.PI * 2 * j) / 72
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)
      const rot = rotatePoint(x, y, z, rx, ry, rz)
      const proj = project(rot.x, rot.y, rot.z)
      points.push({ x: proj.x, y: proj.y, behind: rot.z > 0 })
    }
    drawSegments(points)
  }

  // 绘制一条经线（完整大圆：lon 半圆 + lon+π 半圆，自动区分前后）
  function drawLonLine(lon: number) {
    const points: { x: number; y: number; behind: boolean }[] = []
    // 从北极沿 lon 到南极
    for (let j = 0; j <= 36; j++) {
      const lat = (Math.PI * j) / 36
      const x = r * Math.sin(lat) * Math.cos(lon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(lon)
      const rot = rotatePoint(x, y, z, rx, ry, rz)
      const proj = project(rot.x, rot.y, rot.z)
      points.push({ x: proj.x, y: proj.y, behind: rot.z > 0 })
    }
    // 从南极沿 lon+π 回到北极
    const oppLon = lon + Math.PI
    for (let j = 35; j >= 0; j--) {
      const lat = (Math.PI * j) / 36
      const x = r * Math.sin(lat) * Math.cos(oppLon)
      const y = r * Math.cos(lat)
      const z = r * Math.sin(lat) * Math.sin(oppLon)
      const rot = rotatePoint(x, y, z, rx, ry, rz)
      const proj = project(rot.x, rot.y, rot.z)
      points.push({ x: proj.x, y: proj.y, behind: rot.z > 0 })
    }
    drawSegments(points)
  }

  // 按前后分段绘制，背面用虚线+低透明度
  function drawSegments(points: { x: number; y: number; behind: boolean }[]) {
    if (points.length < 2) return
    let i = 0
    while (i < points.length - 1) {
      const behind = points[i]!.behind
      ctx.beginPath()
      ctx.moveTo(points[i]!.x, points[i]!.y)
      while (i < points.length - 1 && points[i + 1]!.behind === behind) {
        i++
        ctx.lineTo(points[i]!.x, points[i]!.y)
      }
      ctx.strokeStyle = behind ? backColor : frontColor
      ctx.setLineDash(behind ? [4, 3] : [])
      ctx.lineWidth = 1
      ctx.stroke()
      i++
    }
    ctx.setLineDash([])
  }

  // 纬线
  const latitudes = [Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4]
  for (const lat of latitudes) {
    drawLatLine(lat)
  }

  // 经线（完整大圆）
  const longitudes = [(-Math.PI * 3) / 4, -Math.PI / 2, -Math.PI / 4]
  for (const lon of longitudes) {
    drawLonLine(lon)
  }
}

function drawSquare(ctx: CanvasRenderingContext2D) {
  const s = squareSize.value
  const ox = center.value.x - s / 2
  const oy = center.value.y - s / 2
  ctx.fillStyle = colors.value.squareColor
  ctx.strokeStyle = colors.value.squareStroke
  ctx.lineWidth = 2
  ctx.fillRect(ox, oy, s, s)
  ctx.strokeRect(ox, oy, s, s)
}

function drawInnerRect(ctx: CanvasRenderingContext2D) {
  const innerSize = squareSize.value * Math.sqrt(0.5)
  const ix = center.value.x - innerSize / 2
  const iy = center.value.y - innerSize / 2
  ctx.setLineDash([4, 2])
  ctx.strokeStyle = colors.value.innerRectStroke
  ctx.lineWidth = 1
  ctx.strokeRect(ix, iy, innerSize, innerSize)
  ctx.setLineDash([])
}

function drawCornerLines(
  ctx: CanvasRenderingContext2D,
  pt: { x: number; y: number; depth: number }
) {
  const s = squareSize.value
  const ox = center.value.x - s / 2
  const oy = center.value.y - s / 2
  const corners = [
    { x: ox, y: oy },
    { x: ox + s, y: oy },
    { x: ox, y: oy + s },
    { x: ox + s, y: oy + s }
  ]
  const isBehind = pt.depth > 0

  ctx.lineWidth = 2
  for (const c of corners) {
    // 创建从拖动点(深)到角点(浅)的线性渐变
    const gradient = ctx.createLinearGradient(pt.x, pt.y, c.x, c.y)
    if (props.darkMode) {
      if (isBehind) {
        // 暗色背面：保持深到浅渐变，整体更透明
        gradient.addColorStop(0, "rgba(255,255,255,0.25)")
        gradient.addColorStop(1, "rgba(255,255,255,0.05)")
      } else {
        // 暗色正面：深到浅渐变
        gradient.addColorStop(0, "rgba(255,255,255,0.6)")
        gradient.addColorStop(1, "rgba(255,255,255,0.1)")
      }
    } else {
      if (isBehind) {
        // 亮色背面：保持深到浅渐变，整体更透明
        gradient.addColorStop(0, "rgba(59,130,246,0.3)")
        gradient.addColorStop(1, "rgba(59,130,246,0.05)")
      } else {
        // 亮色正面：深到浅渐变
        gradient.addColorStop(0, "rgba(59,130,246,0.7)")
        gradient.addColorStop(1, "rgba(59,130,246,0.15)")
      }
    }
    ctx.strokeStyle = gradient
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
  ctx.fillStyle = colors.value.pointColor
  for (const c of corners) {
    ctx.beginPath()
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawPoint(
  ctx: CanvasRenderingContext2D,
  pt: { x: number; y: number; scale: number; depth: number }
) {
  // 简化的镜头图标：矩形边框 + 中心球体，浮于球面上方
  const r = sphereRadius.value
  const lift = baseSize.value * 0.08
  const theta = pointTheta.value
  const phi = pointPhi.value

  // 球面上的3D位置（theta=0 朝向屏幕前方）
  const sx = r * Math.sin(phi) * Math.sin(theta)
  const sy = r * Math.cos(phi)
  const sz = -r * Math.sin(phi) * Math.cos(theta)

  // 外法线方向（离开球面）
  const onx = sx / r
  const ony = sy / r
  const onz = sz / r

  // 浮起后的3D位置
  const fx = sx + onx * lift
  const fy = sy + ony * lift
  const fz = sz + onz * lift

  // 构造局部坐标系 (right, up)
  let upX = 0,
    upY = 1,
    upZ = 0
  if (Math.abs(ony) > 0.99) {
    upX = 0
    upY = 0
    upZ = 1
  }

  let rxL = upY * onz - upZ * ony
  let ryL = upZ * onx - upX * onz
  let rzL = upX * ony - upY * onx
  const rLen = Math.sqrt(rxL * rxL + ryL * ryL + rzL * rzL)
  rxL /= rLen
  ryL /= rLen
  rzL /= rLen

  let uxL = ony * rzL - onz * ryL
  let uyL = onz * rxL - onx * rzL
  let uzL = onx * ryL - ony * rxL
  const uLen = Math.sqrt(uxL * uxL + uyL * uyL + uzL * uzL)
  uxL /= uLen
  uyL /= uLen
  uzL /= uLen

  const rotRx = props.defaultRotationX
  const rotRy = props.defaultRotationY
  const rotRz = props.defaultRotationZ

  // 将局部坐标 (right, up) 转换为投影后的2D坐标
  function localToScreen(lr: number, lu: number) {
    const wx = fx + rxL * lr + uxL * lu
    const wy = fy + ryL * lr + uyL * lu
    const wz = fz + rzL * lr + uzL * lu
    const rot = rotatePoint(wx, wy, wz, rotRx, rotRy, rotRz)
    return project(rot.x, rot.y, rot.z)
  }

  // 球面点的投影（用于连接线）
  const surfaceRot = rotatePoint(sx, sy, sz, rotRx, rotRy, rotRz)
  const surfaceProj = project(surfaceRot.x, surfaceRot.y, surfaceRot.z)

  let opacity = Math.max(0.4, Math.min(1, 0.7 + pt.scale * 0.3))
  if (pt.depth > 0) opacity = Math.min(opacity, 0.5)

  ctx.save()
  ctx.globalAlpha = opacity

  // 连接线：从球面到浮起点
  const floatingCenter = localToScreen(0, 0)
  ctx.beginPath()
  ctx.moveTo(surfaceProj.x, surfaceProj.y)
  ctx.lineTo(floatingCenter.x, floatingCenter.y)
  ctx.strokeStyle = colors.value.lineColor
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 矩形边框
  const rectW = baseSize.value * 0.15
  const rectH = baseSize.value * 0.11
  const corners = [
    localToScreen(-rectW, -rectH),
    localToScreen(rectW, -rectH),
    localToScreen(rectW, rectH),
    localToScreen(-rectW, rectH)
  ]

  ctx.beginPath()
  ctx.moveTo(corners[0]!.x, corners[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y)
  ctx.closePath()
  ctx.fillStyle = props.darkMode
    ? "rgba(255,255,255,0.15)"
    : "rgba(59,130,246,0.2)"
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()

  // 中心球体（外圈透明边缘 + 内圈实心）
  const dotR = Math.max(baseSize.value * 0.08 * pt.scale, 3)
  // 外圈：透明边缘
  ctx.beginPath()
  ctx.arc(floatingCenter.x, floatingCenter.y, dotR, 0, Math.PI * 2)
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 1.5
  ctx.stroke()
  // 内圈：实心
  ctx.beginPath()
  ctx.arc(floatingCenter.x, floatingCenter.y, dotR * 0.55, 0, Math.PI * 2)
  ctx.fillStyle = colors.value.pointColor
  ctx.fill()

  // active 状态发光外框
  if (isActive.value) {
    const pad = baseSize.value * 0.03
    const glowCorners = [
      localToScreen(-rectW - pad, -rectH - pad),
      localToScreen(rectW + pad, -rectH - pad),
      localToScreen(rectW + pad, rectH + pad),
      localToScreen(-rectW - pad, rectH + pad)
    ]
    ctx.globalAlpha = opacity * 0.4
    ctx.strokeStyle = colors.value.pointColor
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(glowCorners[0]!.x, glowCorners[0]!.y)
    for (let i = 1; i < 4; i++) ctx.lineTo(glowCorners[i]!.x, glowCorners[i]!.y)
    ctx.closePath()
    ctx.stroke()
  }

  ctx.restore()
}

// ============= 交互 =============
function updateRotation(deltaX: number, deltaY: number) {
  pointTheta.value += deltaX * props.moveSpeed
  const newPhi = pointPhi.value - deltaY * props.moveSpeed
  pointPhi.value = Math.max(
    phiLimits.value.min,
    Math.min(phiLimits.value.max, newPhi)
  )
  emit("update:modelValue", {
    yaw: (pointTheta.value * 180) / Math.PI,
    pitch: ((Math.PI / 2 - pointPhi.value) * 180) / Math.PI,
    zoomLevel: internalZoomLevel.value
  })
  draw()
}

function handleMouseDown(e: MouseEvent) {
  isActive.value = true
  dragStart.value = { x: e.clientX, y: e.clientY }
  e.preventDefault()
  draw()
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
  isActive.value = true
  dragStart.value = { x: touch.clientX, y: touch.clientY }
  e.preventDefault()
  draw()
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

function handleWheel(e: WheelEvent) {
  e.preventDefault()
  const current = internalZoomLevel.value
  let next: "in" | "out" | "unchanged"
  if (e.deltaY < 0) {
    // 向上滚动 → 放大
    next = current === "out" ? "unchanged" : "in"
  } else {
    // 向下滚动 → 缩小
    next = current === "in" ? "unchanged" : "out"
  }
  if (next !== current) {
    internalZoomLevel.value = next
    emit("update:modelValue", {
      yaw: (pointTheta.value * 180) / Math.PI,
      pitch: ((Math.PI / 2 - pointPhi.value) * 180) / Math.PI,
      zoomLevel: next
    })
    draw()
  }
}

// 响应 props 变化重绘
watch(
  () => [
    props.width,
    props.height,
    props.defaultRotationX,
    props.defaultRotationY,
    props.defaultRotationZ,
    props.squareColor,
    props.pointColor,
    props.darkMode
  ],
  () => {
    draw()
  }
)

onMounted(() => {
  draw()
  window.addEventListener("mousemove", handleMouseMove)
  window.addEventListener("mouseup", handleMouseUp)
  if (canvasRef.value) {
    canvasRef.value.addEventListener("wheel", handleWheel, { passive: false })
  }
})

onUnmounted(() => {
  window.removeEventListener("mousemove", handleMouseMove)
  window.removeEventListener("mouseup", handleMouseUp)
  if (canvasRef.value) {
    canvasRef.value.removeEventListener("wheel", handleWheel)
  }
})
</script>

<template>
  <canvas
    ref="canvasRef"
    :style="{
      width: width + 'px',
      height: height + 'px',
      cursor: isActive ? 'grabbing' : 'grab'
    }"
    @mousedown="handleMouseDown"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
  />
</template>
