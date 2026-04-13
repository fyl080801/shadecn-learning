<template>
  <div class="flex flex-col items-center justify-center w-full h-full bg-background py-8">
    <h2 class="text-xl font-semibold mb-6 text-foreground">Canvas 3D 交互</h2>
    <div
      ref="containerRef"
      class="rounded-xl border border-border overflow-hidden"
      :style="{ width: `${canvasSize}px`, height: `${canvasSize}px`, cursor: isDragging ? 'grabbing' : 'grab' }"
      @mousedown="handleMouseDown"
      @touchstart.prevent="handleTouchStart"
    />
    <p class="mt-4 text-sm text-muted-foreground">拖拽控制点球体移动</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import * as THREE from 'three'

// ── 常量 ─────────────────────────────────────────────────────
const canvasSize = 480
const SPHERE_R = 150 / 240         // 归一化到 three 场景单位（视口高度约 2 个单位）
const RECT_SIZE = 110 / 240
const MOVE_SPEED = 0.006
const PHI_MIN = (30 * Math.PI) / 180
const PHI_MAX = Math.PI - (10 * Math.PI) / 180

// 主色调（indigo-500 #6366f1）
const INDIGO = 0x6366f1

// ── 状态 ─────────────────────────────────────────────────────
const containerRef = ref<HTMLDivElement | null>(null)
const pointTheta = ref(0.4)
const pointPhi = ref(Math.PI / 2.2)
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// ── Three.js 对象 ──────────────────────────────────────────────
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.OrthographicCamera
let animId: number

// 控制点（可拖拽的球体）
let controlPoint: THREE.Mesh
// 连线（4 条从矩形角到控制点）
const connectLines: THREE.Line[] = []
// 球面网格线
const gridLines: THREE.Line[] = []
// 矩形
let rectMesh: THREE.Mesh
let rectBorder: THREE.Line
// 矩形四角点
const cornerDots: THREE.Mesh[] = []

// ── 场景初始化 ─────────────────────────────────────────────────
function initScene() {
  const container = containerRef.value!
  const W = canvasSize
  const H = canvasSize

  // 渲染器
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(W, H)
  renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)

  // 场景
  scene = new THREE.Scene()

  // 正交相机，视口覆盖 [-1,1]×[-1,1]
  const aspect = W / H
  camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 100)
  camera.position.set(0, 0, 5)

  // 固定视角旋转（45° 斜下，绕 Y 轴 45°）：放在一个场景根 Group 里
  const root = new THREE.Group()
  root.rotation.order = 'YXZ'
  root.rotation.y = (45 * Math.PI) / 180
  root.rotation.x = (45 * Math.PI) / 180
  scene.add(root)

  // ─ 球体轮廓（wireframe 用 EdgesGeometry 代替）─
  const sphereGeo = new THREE.SphereGeometry(SPHERE_R, 24, 12)
  const sphereEdges = new THREE.EdgesGeometry(sphereGeo)

  // 把 EdgesGeometry 拆成经纬线：直接绘制格线
  buildGridLines(root)

  // ─ 矩形（在 XZ 水平面，法线朝 Y 轴，经 root 旋转后朝向斜下45°）─
  const hw = RECT_SIZE / 2
  // 顶点在 XZ 平面（y=0）
  const rectVerts = [
    new THREE.Vector3(-hw, 0, -hw),
    new THREE.Vector3( hw, 0, -hw),
    new THREE.Vector3( hw, 0,  hw),
    new THREE.Vector3(-hw, 0,  hw),
  ]
  // 填充面（两个三角形）
  const rectFillGeo = new THREE.BufferGeometry()
  rectFillGeo.setFromPoints([
    rectVerts[0]!, rectVerts[1]!, rectVerts[2]!,
    rectVerts[0]!, rectVerts[2]!, rectVerts[3]!,
  ])
  rectMesh = new THREE.Mesh(
    rectFillGeo,
    new THREE.MeshBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
  )
  root.add(rectMesh)

  // 边框
  const rectPts = [...rectVerts, rectVerts[0]!]
  const rectBorderGeo = new THREE.BufferGeometry().setFromPoints(rectPts)
  rectBorder = new THREE.Line(
    rectBorderGeo,
    new THREE.LineBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.75 })
  )
  root.add(rectBorder)

  // ─ 矩形四角点（小球，始终朝相机，用 Sprite 代替 CircleGeometry）─
  rectVerts.forEach((v) => {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.013, 12, 12),
      new THREE.MeshBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.9 })
    )
    dot.position.copy(v)
    root.add(dot)
    cornerDots.push(dot)
  })

  // ─ 连线（4 条，动态更新）─
  // 连线从矩形四角（XZ平面）到控制点
  for (let i = 0; i < 4; i++) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.5 })
    )
    root.add(line)
    connectLines.push(line)
  }

  // ─ 控制点球体 ─
  controlPoint = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 32, 32),
    new THREE.MeshPhongMaterial({ color: INDIGO, shininess: 120, specular: 0xffffff })
  )
  root.add(controlPoint)

  // 光源（给控制点球体打高光）
  const ambLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambLight)
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
  dirLight.position.set(-1, 2, 3)
  scene.add(dirLight)

  // 删除 sphereEdges（已改用手动格线，避免无用对象）
  sphereEdges.dispose()
  sphereGeo.dispose()
}

// ── 手动绘制经纬线格 ──────────────────────────────────────────
function buildGridLines(root: THREE.Group) {
  const R = SPHERE_R
  const mat = new THREE.LineBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.32 })

  // ─ 球体轮廓线（垂直于相机视线的大圆）─
  // 相机沿 -Z 看，视线在 root 局部空间中需经过逆旋转还原
  // root 旋转顺序 YXZ：先绕Y(45°)再绕X(45°)
  // 视线世界方向 (0,0,-1)，逆变换：先绕X逆(-45°)再绕Y逆(-45°)
  {
    const RX = -(45 * Math.PI) / 180
    const RY = -(45 * Math.PI) / 180
    // 视线 (0,0,-1) 先绕X逆旋转
    let nx = 0, ny = -Math.sin(RX) * (-1), nz = Math.cos(RX) * (-1)
    // 再绕Y逆旋转
    const nx2 = Math.cos(RY) * nx + Math.sin(RY) * nz
    const ny2 = ny
    const nz2 = -Math.sin(RY) * nx + Math.cos(RY) * nz
    nx = nx2; ny = ny2; nz = nz2

    // 构造垂直于法线的两个正交基向量
    let u1x = 1, u1y = 0, u1z = 0
    if (Math.abs(nx) > 0.9) { u1x = 0; u1y = 1; u1z = 0 }
    const dot = u1x * nx + u1y * ny + u1z * nz
    u1x -= dot * nx; u1y -= dot * ny; u1z -= dot * nz
    const u1len = Math.sqrt(u1x * u1x + u1y * u1y + u1z * u1z)
    u1x /= u1len; u1y /= u1len; u1z /= u1len
    const u2x = ny * u1z - nz * u1y
    const u2y = nz * u1x - nx * u1z
    const u2z = nx * u1y - ny * u1x

    const pts: THREE.Vector3[] = []
    for (let j = 0; j <= 72; j++) {
      const t = (Math.PI * 2 * j) / 72
      pts.push(new THREE.Vector3(
        R * (Math.cos(t) * u1x + Math.sin(t) * u2x),
        R * (Math.cos(t) * u1y + Math.sin(t) * u2y),
        R * (Math.cos(t) * u1z + Math.sin(t) * u2z),
      ))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const outline = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: INDIGO, transparent: true, opacity: 0.45, linewidth: 2 })
    )
    root.add(outline)
    gridLines.push(outline)
  }

  // 纬线 3 条
  for (let li = 1; li <= 3; li++) {
    const lat = (Math.PI * li) / 4
    const pts: THREE.Vector3[] = []
    for (let j = 0; j <= 72; j++) {
      const lon = (Math.PI * 2 * j) / 72
      pts.push(new THREE.Vector3(
        R * Math.sin(lat) * Math.cos(lon),
        R * Math.cos(lat),
        R * Math.sin(lat) * Math.sin(lon)
      ))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.Line(geo, mat.clone())
    root.add(line)
    gridLines.push(line)
  }

  // 经线 4 条
  for (let li = 0; li < 4; li++) {
    const lon = (Math.PI * 2 * li) / 4
    const pts: THREE.Vector3[] = []
    for (let j = 0; j <= 36; j++) {
      const lat = (Math.PI * j) / 36
      pts.push(new THREE.Vector3(
        R * Math.sin(lat) * Math.cos(lon),
        R * Math.cos(lat),
        R * Math.sin(lat) * Math.sin(lon)
      ))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.Line(geo, mat.clone())
    root.add(line)
    gridLines.push(line)
  }
}

// ── 更新控制点位置与连线 ──────────────────────────────────────
function updateScene() {
  const R = SPHERE_R
  const theta = pointTheta.value
  const phi = pointPhi.value
  const x = R * Math.sin(phi) * Math.cos(theta)
  const y = R * Math.cos(phi)
  const z = R * Math.sin(phi) * Math.sin(theta)

  controlPoint.position.set(x, y, z)

  // 更新 4 条连线（角点在 XZ 平面，y=0）
  const hw = RECT_SIZE / 2
  const corners = [
    new THREE.Vector3(-hw, 0, -hw),
    new THREE.Vector3( hw, 0, -hw),
    new THREE.Vector3( hw, 0,  hw),
    new THREE.Vector3(-hw, 0,  hw),
  ]
  const ptVec = new THREE.Vector3(x, y, z)
  connectLines.forEach((line, i) => {
    const geo = line.geometry as THREE.BufferGeometry
    geo.setFromPoints([corners[i]!, ptVec])
    geo.attributes.position!.needsUpdate = true
  })
}

// ── 渲染循环 ───────────────────────────────────────────────────
function animate() {
  animId = requestAnimationFrame(animate)
  updateScene()
  renderer.render(scene, camera)
}

// ── 拖拽事件 ──────────────────────────────────────────────────
function handleMouseDown(e: MouseEvent) {
  isDragging.value = true
  dragStart.value = { x: e.clientX, y: e.clientY }
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  move(e.clientX - dragStart.value.x, e.clientY - dragStart.value.y)
  dragStart.value = { x: e.clientX, y: e.clientY }
}

function onMouseUp() {
  isDragging.value = false
}

function handleTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  isDragging.value = true
  dragStart.value = { x: t.clientX, y: t.clientY }
}

function onTouchMove(e: TouchEvent) {
  if (!isDragging.value) return
  const t = e.touches[0]
  if (!t) return
  move(t.clientX - dragStart.value.x, t.clientY - dragStart.value.y)
  dragStart.value = { x: t.clientX, y: t.clientY }
  e.preventDefault()
}

function move(dx: number, dy: number) {
  pointTheta.value += dx * MOVE_SPEED
  pointPhi.value = Math.max(PHI_MIN, Math.min(PHI_MAX, pointPhi.value + dy * MOVE_SPEED))
}

// ── 生命周期 ──────────────────────────────────────────────────
onMounted(() => {
  initScene()
  animate()
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onMouseUp)
})

onUnmounted(() => {
  cancelAnimationFrame(animId)
  renderer.dispose()
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onMouseUp)
})
</script>