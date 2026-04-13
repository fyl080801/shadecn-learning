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
  darkMode: false
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
    gridBack: props.gridColor.replace(/[\d.]+\)$/, '0.1)'),
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

  // 7. 摄像机矩形外框
  drawCameraRect(ctx, pt)

  // 8. 拖动点
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
    ctx.strokeStyle = colors.value.outlineColor
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawGridLines(ctx: CanvasRenderingContext2D, r: number, rx: number, ry: number, rz: number) {
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
  const latitudes = [
    Math.PI / 4,
    Math.PI / 2,
    (Math.PI * 3) / 4
  ]
  for (const lat of latitudes) {
    drawLatLine(lat)
  }

  // 经线（完整大圆）
  const longitudes = [
    -Math.PI * 3 / 4,
    -Math.PI / 2,
    -Math.PI / 4
  ]
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

function drawCameraRect(ctx: CanvasRenderingContext2D, pt: { x: number; y: number; scale: number; depth: number }) {
  // 摄像机矩形外框，在拖动点位置绘制一个朝向球心的3D矩形
  const r = sphereRadius.value
  const theta = pointTheta.value
  const phi = pointPhi.value

  // 点在球面上的3D位置（未旋转前）
  const px = r * Math.sin(phi) * Math.cos(theta)
  const py = r * Math.cos(phi)
  const pz = r * Math.sin(phi) * Math.sin(theta)

  // 摄像机朝向球心的方向（法线，指向球心）
  const nx = -Math.sin(phi) * Math.cos(theta)
  const ny = -Math.cos(phi)
  const nz = -Math.sin(phi) * Math.sin(theta)

  // 构造摄像机矩形的局部坐标系
  // up 近似为世界Y轴，然后正交化
  let upX = 0, upY = 1, upZ = 0
  // 如果法线几乎平行于Y轴，用Z轴作为up
  if (Math.abs(ny) > 0.99) {
    upX = 0; upY = 0; upZ = 1
  }

  // right = normalize(cross(up, n))
  let rx2 = upY * nz - upZ * ny
  let ry2 = upZ * nx - upX * nz
  let rz2 = upX * ny - upY * nx
  const rLen = Math.sqrt(rx2 * rx2 + ry2 * ry2 + rz2 * rz2)
  rx2 /= rLen; ry2 /= rLen; rz2 /= rLen

  // recalculate up = normalize(cross(n, right))
  let ux = ny * rz2 - nz * ry2
  let uy = nz * rx2 - nx * rz2
  let uz = nx * ry2 - ny * rx2
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz)
  ux /= uLen; uy /= uLen; uz /= uLen

  // 矩形的半宽/半高（模拟摄像机尺寸）
  const camW = squareSize.value * 0.18
  const camH = squareSize.value * 0.13
  // 摄像机"镜头筒"深度
  const camDepth = squareSize.value * 0.1

  // 前面矩形4个顶点（在球面点位置，朝向球心的平面上）
  const frontCorners = [
    { x: px - rx2 * camW - ux * camH, y: py - ry2 * camW - uy * camH, z: pz - rz2 * camW - uz * camH },
    { x: px + rx2 * camW - ux * camH, y: py + ry2 * camW - uy * camH, z: pz + rz2 * camW - uz * camH },
    { x: px + rx2 * camW + ux * camH, y: py + ry2 * camW + uy * camH, z: pz + rz2 * camW + uz * camH },
    { x: px - rx2 * camW + ux * camH, y: py - ry2 * camW + uy * camH, z: pz - rz2 * camW + uz * camH }
  ]

  // 后面矩形4个顶点（沿法线反方向偏移，即远离球心方向）
  const backCorners = frontCorners.map(c => ({
    x: c.x - nx * camDepth,
    y: c.y - ny * camDepth,
    z: c.z - nz * camDepth
  }))

  // 对所有顶点应用全局旋转 + 投影
  const rotRx = props.defaultRotationX
  const rotRy = props.defaultRotationY
  const rotRz = props.defaultRotationZ

  function projectCorner(c: { x: number; y: number; z: number }) {
    const rot = rotatePoint(c.x, c.y, c.z, rotRx, rotRy, rotRz)
    return project(rot.x, rot.y, rot.z)
  }

  const fp = frontCorners.map(projectCorner)
  const bp = backCorners.map(projectCorner)

  let opacity = Math.max(0.4, Math.min(1, 0.7 + pt.scale * 0.3))
  if (pt.depth > 0) opacity = Math.min(opacity, 0.5)

  ctx.save()
  ctx.globalAlpha = opacity

  // 绘制背面矩形（先画背面，再画侧面，最后画前面，实现层次感）
  ctx.beginPath()
  ctx.moveTo(bp[0]!.x, bp[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(bp[i]!.x, bp[i]!.y)
  ctx.closePath()
  ctx.fillStyle = colors.value.camBackFill
  ctx.strokeStyle = colors.value.camBackStroke
  ctx.lineWidth = 1
  ctx.fill()
  ctx.stroke()

  // 绘制4条连接边（侧面边线）
  ctx.strokeStyle = colors.value.camSideStroke
  ctx.lineWidth = 1
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.moveTo(fp[i]!.x, fp[i]!.y)
    ctx.lineTo(bp[i]!.x, bp[i]!.y)
    ctx.stroke()
  }

  // 绘制前面矩形（摄像机正面）
  ctx.beginPath()
  ctx.moveTo(fp[0]!.x, fp[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(fp[i]!.x, fp[i]!.y)
  ctx.closePath()
  ctx.fillStyle = colors.value.camFrontFill
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()

  // 绘制前面矩形中的"镜头"圆形
  const lensCx = (fp[0]!.x + fp[1]!.x + fp[2]!.x + fp[3]!.x) / 4
  const lensCy = (fp[0]!.y + fp[1]!.y + fp[2]!.y + fp[3]!.y) / 4
  const lensR = camH * pt.scale * 0.5
  ctx.beginPath()
  ctx.arc(lensCx, lensCy, lensR, 0, Math.PI * 2)
  ctx.strokeStyle = colors.value.camLensStroke
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.restore()
}

function drawPoint(ctx: CanvasRenderingContext2D, pt: { x: number; y: number; scale: number; depth: number }) {
  // 3D矢量变换的摄像机镜头图标
  const r = sphereRadius.value
  const theta = pointTheta.value
  const phi = pointPhi.value

  // 球面上的3D位置
  const px = r * Math.sin(phi) * Math.cos(theta)
  const py = r * Math.cos(phi)
  const pz = r * Math.sin(phi) * Math.sin(theta)

  // 法线方向（指向球心）
  const nx = -Math.sin(phi) * Math.cos(theta)
  const ny = -Math.cos(phi)
  const nz = -Math.sin(phi) * Math.sin(theta)

  // 构造局部坐标系 (right, up, normal)
  let upX = 0, upY = 1, upZ = 0
  if (Math.abs(ny) > 0.99) { upX = 0; upY = 0; upZ = 1 }

  let rxL = upY * nz - upZ * ny
  let ryL = upZ * nx - upX * nz
  let rzL = upX * ny - upY * nx
  const rLen = Math.sqrt(rxL * rxL + ryL * ryL + rzL * rzL)
  rxL /= rLen; ryL /= rLen; rzL /= rLen

  let uxL = ny * rzL - nz * ryL
  let uyL = nz * rxL - nx * rzL
  let uzL = nx * ryL - ny * rxL
  const uLen = Math.sqrt(uxL * uxL + uyL * uyL + uzL * uzL)
  uxL /= uLen; uyL /= uLen; uzL /= uLen

  const rotRx = props.defaultRotationX
  const rotRy = props.defaultRotationY
  const rotRz = props.defaultRotationZ

  // 将局部坐标 (lr, lu, ln) 转换为投影后的2D坐标
  function localToScreen(lr: number, lu: number, ln: number) {
    const wx = px + rxL * lr + uxL * lu + nx * ln
    const wy = py + ryL * lr + uyL * lu + ny * ln
    const wz = pz + rzL * lr + uzL * lu + nz * ln
    const rot = rotatePoint(wx, wy, wz, rotRx, rotRy, rotRz)
    return project(rot.x, rot.y, rot.z)
  }

  let opacity = Math.max(0.4, Math.min(1, 0.7 + pt.scale * 0.3))
  if (pt.depth > 0) opacity = Math.min(opacity, 0.5)

  ctx.save()
  ctx.globalAlpha = opacity

  // 摄像机尺寸参数（在局部3D空间中的大小）
  const camW = squareSize.value * 0.22  // 半宽
  const camH = squareSize.value * 0.16  // 半高
  const camDepth = squareSize.value * 0.06 // 主体在法线方向的厚度

  // === 摄像机主体：前面4顶点 + 后面4顶点 ===
  const frontCorners = [
    localToScreen(-camW, -camH, 0),
    localToScreen( camW, -camH, 0),
    localToScreen( camW,  camH, 0),
    localToScreen(-camW,  camH, 0)
  ]
  const backCorners = [
    localToScreen(-camW, -camH, -camDepth),
    localToScreen( camW, -camH, -camDepth),
    localToScreen( camW,  camH, -camDepth),
    localToScreen(-camW,  camH, -camDepth)
  ]

  // 阴影
  ctx.shadowColor = props.darkMode ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.3)"
  ctx.shadowBlur = 8
  ctx.shadowOffsetX = 2
  ctx.shadowOffsetY = 2

  // 绘制背面
  ctx.beginPath()
  ctx.moveTo(backCorners[0]!.x, backCorners[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(backCorners[i]!.x, backCorners[i]!.y)
  ctx.closePath()
  ctx.fillStyle = props.darkMode ? "rgba(255,255,255,0.08)" : "rgba(59,130,246,0.1)"
  ctx.strokeStyle = colors.value.camBackStroke
  ctx.lineWidth = 1
  ctx.fill()
  ctx.stroke()

  ctx.shadowColor = "transparent"
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // 绘制侧面边线
  ctx.strokeStyle = colors.value.camSideStroke
  ctx.lineWidth = 1
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.moveTo(frontCorners[i]!.x, frontCorners[i]!.y)
    ctx.lineTo(backCorners[i]!.x, backCorners[i]!.y)
    ctx.stroke()
  }

  // 绘制前面（摄像机正面）
  ctx.beginPath()
  ctx.moveTo(frontCorners[0]!.x, frontCorners[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(frontCorners[i]!.x, frontCorners[i]!.y)
  ctx.closePath()
  ctx.fillStyle = props.darkMode ? "rgba(255,255,255,0.15)" : "rgba(59,130,246,0.2)"
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()

  // === 镜头（前面中心的3D椭圆） ===
  const lensR = camH * 0.6
  const lensSteps = 32
  ctx.beginPath()
  for (let i = 0; i <= lensSteps; i++) {
    const angle = (Math.PI * 2 * i) / lensSteps
    const lp = localToScreen(
      lensR * Math.cos(angle),
      lensR * Math.sin(angle),
      0
    )
    if (i === 0) ctx.moveTo(lp.x, lp.y)
    else ctx.lineTo(lp.x, lp.y)
  }
  ctx.closePath()
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 2
  ctx.stroke()

  // 镜头内圈
  const innerR = lensR * 0.55
  ctx.beginPath()
  for (let i = 0; i <= lensSteps; i++) {
    const angle = (Math.PI * 2 * i) / lensSteps
    const lp = localToScreen(
      innerR * Math.cos(angle),
      innerR * Math.sin(angle),
      0
    )
    if (i === 0) ctx.moveTo(lp.x, lp.y)
    else ctx.lineTo(lp.x, lp.y)
  }
  ctx.closePath()
  ctx.fillStyle = colors.value.pointColor
  ctx.globalAlpha = opacity * 0.4
  ctx.fill()
  ctx.globalAlpha = opacity

  // 镜头高光（偏左上）
  const hlR = innerR * 0.3
  ctx.beginPath()
  for (let i = 0; i <= lensSteps; i++) {
    const angle = (Math.PI * 2 * i) / lensSteps
    const lp = localToScreen(
      -innerR * 0.25 + hlR * Math.cos(angle),
      -innerR * 0.25 + hlR * Math.sin(angle),
      0
    )
    if (i === 0) ctx.moveTo(lp.x, lp.y)
    else ctx.lineTo(lp.x, lp.y)
  }
  ctx.closePath()
  ctx.fillStyle = props.darkMode ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.7)"
  ctx.fill()

  ctx.globalAlpha = opacity

  // === 取景器（主体右上方的3D凸起） ===
  const vfW2 = camW * 0.35   // 取景器半宽
  const vfH2 = camH * 0.25   // 取景器半高
  const vfOffsetR = camW * 0.3  // 右偏移
  const vfOffsetU = -camH - vfH2  // 在主体上方

  const vfFront = [
    localToScreen(vfOffsetR - vfW2, vfOffsetU - vfH2, 0),
    localToScreen(vfOffsetR + vfW2, vfOffsetU - vfH2, 0),
    localToScreen(vfOffsetR + vfW2, vfOffsetU + vfH2, 0),
    localToScreen(vfOffsetR - vfW2, vfOffsetU + vfH2, 0)
  ]
  const vfBack = [
    localToScreen(vfOffsetR - vfW2, vfOffsetU - vfH2, -camDepth),
    localToScreen(vfOffsetR + vfW2, vfOffsetU - vfH2, -camDepth),
    localToScreen(vfOffsetR + vfW2, vfOffsetU + vfH2, -camDepth),
    localToScreen(vfOffsetR - vfW2, vfOffsetU + vfH2, -camDepth)
  ]

  // 取景器背面
  ctx.beginPath()
  ctx.moveTo(vfBack[0]!.x, vfBack[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(vfBack[i]!.x, vfBack[i]!.y)
  ctx.closePath()
  ctx.fillStyle = props.darkMode ? "rgba(255,255,255,0.06)" : "rgba(59,130,246,0.08)"
  ctx.strokeStyle = colors.value.camBackStroke
  ctx.lineWidth = 1
  ctx.fill()
  ctx.stroke()

  // 取景器侧面
  ctx.strokeStyle = colors.value.camSideStroke
  ctx.lineWidth = 1
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.moveTo(vfFront[i]!.x, vfFront[i]!.y)
    ctx.lineTo(vfBack[i]!.x, vfBack[i]!.y)
    ctx.stroke()
  }

  // 取景器正面
  ctx.beginPath()
  ctx.moveTo(vfFront[0]!.x, vfFront[0]!.y)
  for (let i = 1; i < 4; i++) ctx.lineTo(vfFront[i]!.x, vfFront[i]!.y)
  ctx.closePath()
  ctx.fillStyle = props.darkMode ? "rgba(255,255,255,0.12)" : "rgba(59,130,246,0.15)"
  ctx.strokeStyle = colors.value.pointColor
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()

  // === active 状态发光外框 ===
  if (isActive.value) {
    const pad = squareSize.value * 0.04
    const glowCorners = [
      localToScreen(-camW - pad, -camH - pad, 0),
      localToScreen( camW + pad, -camH - pad, 0),
      localToScreen( camW + pad,  camH + pad, 0),
      localToScreen(-camW - pad,  camH + pad, 0)
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
  // 碰撞区域与3D摄像机图标尺寸匹配
  const camW = squareSize.value * 0.22
  const camH = squareSize.value * 0.16
  const hitSize = Math.max(camW, camH) * pt.scale + 10
  const dx = ex - pt.x, dy = ey - pt.y
  return dx * dx + dy * dy <= hitSize * hitSize
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
watch(() => [props.width, props.height, props.defaultRotationX, props.defaultRotationY, props.defaultRotationZ, props.squareColor, props.pointColor, props.darkMode], () => {
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