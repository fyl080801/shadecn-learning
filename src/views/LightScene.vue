<template>
  <div class="light-scene-container" ref="containerRef">
    <div class="info-panel">
      <p>鼠标移动控制光源位置</p>
      <p>光源坐标: ({{ lightPos.x }}, {{ lightPos.y }}, {{ lightPos.z }})</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'

const containerRef = ref<HTMLDivElement | null>(null)
const lightPos = ref({ x: '0.00', y: '0.00', z: '0.00' })

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let animationId: number
let directionalLight: THREE.DirectionalLight
let lightSphere: THREE.Mesh
let lightHelper: THREE.Mesh

// 球体半径
const SPHERE_RADIUS = 4

// 当前球面坐标（用球坐标系表示）
let theta = Math.PI / 4  // 极角
let phi = Math.PI / 4    // 方位角

// 鼠标拖拽
let isDragging = false
let lastMouseX = 0
let lastMouseY = 0

function initScene() {
  const container = containerRef.value!
  const width = container.clientWidth
  const height = container.clientHeight

  // 场景
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111122)

  // 相机
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  // 渲染器
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // ===== 中心二维平面 =====
  const planeGeometry = new THREE.PlaneGeometry(3, 3, 20, 20)
  const planeMaterial = new THREE.MeshStandardMaterial({
    color: 0x4488ff,
    side: THREE.DoubleSide,
    roughness: 0.5,
    metalness: 0.1,
  })
  const plane = new THREE.Mesh(planeGeometry, planeMaterial)
  plane.receiveShadow = true
  scene.add(plane)

  // 平面边框
  const edgesGeo = new THREE.EdgesGeometry(planeGeometry)
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x88ccff })
  const edges = new THREE.LineSegments(edgesGeo, edgesMat)
  scene.add(edges)

  // ===== 外围线框球体 =====
  const wireSphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 24, 16)
  const wireSphereMat = new THREE.MeshBasicMaterial({
    color: 0x334455,
    wireframe: true,
    transparent: true,
    opacity: 0.25,
  })
  const wireSphere = new THREE.Mesh(wireSphereGeo, wireSphereMat)
  scene.add(wireSphere)

  // ===== 光源 =====
  // 环境光（微弱）
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.15)
  scene.add(ambientLight)

  // 主平行光（方向光，模拟点光源方向照向中心）
  directionalLight = new THREE.DirectionalLight(0xfff5cc, 2.5)
  directionalLight.castShadow = true
  directionalLight.shadow.mapSize.set(1024, 1024)
  directionalLight.shadow.camera.near = 0.5
  directionalLight.shadow.camera.far = 20
  directionalLight.shadow.camera.left = -4
  directionalLight.shadow.camera.right = 4
  directionalLight.shadow.camera.top = 4
  directionalLight.shadow.camera.bottom = -4
  directionalLight.target.position.set(0, 0, 0)
  scene.add(directionalLight)
  scene.add(directionalLight.target)

  // 光源位置指示球
  const lightSphereGeo = new THREE.SphereGeometry(0.15, 16, 16)
  const lightSphereMat = new THREE.MeshBasicMaterial({ color: 0xffee44 })
  lightSphere = new THREE.Mesh(lightSphereGeo, lightSphereMat)
  scene.add(lightSphere)

  // 光线射线（从光源到中心的连线）
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffee44, transparent: true, opacity: 0.6 })
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
  lightHelper = new THREE.Mesh() // 复用变量作占位，实际用 line
  const lightLine = new THREE.Line(lineGeo, lineMat)
  lightLine.name = 'lightLine'
  scene.add(lightLine)

  // 光晕效果（点光源）
  const pointLight = new THREE.PointLight(0xfff5cc, 1.0, 6)
  pointLight.name = 'pointLight'
  scene.add(pointLight)

  // 更新光源到初始位置
  updateLightPosition()

  // 窗口缩放
  window.addEventListener('resize', onResize)

  // 鼠标事件
  const canvas = renderer.domElement
  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseup', onMouseUp)
  canvas.addEventListener('mouseleave', onMouseUp)
  // 触摸支持
  canvas.addEventListener('touchstart', onTouchStart, { passive: true })
  canvas.addEventListener('touchmove', onTouchMove, { passive: true })
  canvas.addEventListener('touchend', onMouseUp)

  animate()
}

function sphericalToCartesian(theta: number, phi: number, r: number) {
  return new THREE.Vector3(
    r * Math.sin(theta) * Math.cos(phi),
    r * Math.cos(theta),
    r * Math.sin(theta) * Math.sin(phi),
  )
}

function updateLightPosition() {
  const pos = sphericalToCartesian(theta, phi, SPHERE_RADIUS)

  // 方向光位置
  directionalLight.position.copy(pos)

  // 光源指示球
  lightSphere.position.copy(pos)

  // 点光源跟随
  const pointLight = scene.getObjectByName('pointLight') as THREE.PointLight
  if (pointLight) pointLight.position.copy(pos)

  // 更新光线
  const lightLine = scene.getObjectByName('lightLine') as THREE.Line
  if (lightLine) {
    const positions = lightLine.geometry.attributes.position as THREE.BufferAttribute
    positions.setXYZ(0, pos.x, pos.y, pos.z)
    positions.setXYZ(1, 0, 0, 0)
    positions.needsUpdate = true
  }

  // 更新显示坐标
  lightPos.value = {
    x: pos.x.toFixed(2),
    y: pos.y.toFixed(2),
    z: pos.z.toFixed(2),
  }
}

function animate() {
  animationId = requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

function onResize() {
  if (!containerRef.value) return
  const w = containerRef.value.clientWidth
  const h = containerRef.value.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

const raycaster = new THREE.Raycaster()
// 扩大光源球拾取半径，更易点中
raycaster.params.Points = { threshold: 0.3 }

function hitLightSphere(clientX: number, clientY: number): boolean {
  const canvas = renderer.domElement
  const rect = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(ndc, camera)
  // 用稍大一点的虚拟球做碰撞检测，方便点中
  const hitSphere = new THREE.Sphere(lightSphere.position, 0.4)
  return raycaster.ray.intersectsSphere(hitSphere)
}

// 用雅可比投影将屏幕像素偏移映射到 dTheta/dPhi，全程连续无边界跳变
// 原理：对球坐标求偏导 ∂P/∂theta、∂P/∂phi，投影到相机视图平面，
//       然后用最小二乘解出当前像素偏移对应的 dTheta/dPhi
function applyDelta(dx: number, dy: number) {
  const canvas = renderer.domElement
  const rect = canvas.getBoundingClientRect()

  // 像素偏移归一化到 NDC 尺度（[-1,1] 对应画布宽/高）
  const ndcDx = (dx / rect.width) * 2
  const ndcDy = -(dy / rect.height) * 2  // 屏幕 y 轴朝下，NDC 朝上，取反

  // 当前位置的球坐标偏导（世界空间切向量）
  const sinT = Math.sin(theta), cosT = Math.cos(theta)
  const sinP = Math.sin(phi),   cosP = Math.cos(phi)
  const R = SPHERE_RADIUS

  // ∂P/∂theta（极角方向切线）
  const dPdTheta = new THREE.Vector3(
     R * cosT * cosP,
    -R * sinT,
     R * cosT * sinP,
  )
  // ∂P/∂phi（方位角方向切线）
  const dPdPhi = new THREE.Vector3(
    -R * sinT * sinP,
     0,
     R * sinT * cosP,
  )

  // 将切向量投影到相机视图空间的 XY 平面（即屏幕空间）
  // 使用相机的 projectionMatrix * viewMatrix 得到 MVP，只取 XY 分量
  const mvp = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  )

  // 把世界空间向量用 MVP 变换到裁剪空间（只取方向，w=0 的变换）
  function projectDir(v: THREE.Vector3): THREE.Vector2 {
    const m = mvp.elements
    const x = m[0]*v.x + m[4]*v.y + m[8]*v.z
    const y = m[1]*v.x + m[5]*v.y + m[9]*v.z
    return new THREE.Vector2(x, y)
  }

  const jTheta = projectDir(dPdTheta)  // 屏幕上 dTheta=1 对应的 NDC 偏移
  const jPhi   = projectDir(dPdPhi)    // 屏幕上 dPhi=1   对应的 NDC 偏移

  // 解方程：jTheta * dTheta + jPhi * dPhi = (ndcDx, ndcDy)
  // 用行列式法（2x2 最小二乘）
  const det = jTheta.x * jPhi.y - jTheta.y * jPhi.x
  let dTheta: number, dPhi: number
  if (Math.abs(det) > 1e-6) {
    // 精确解
    dTheta = (ndcDx * jPhi.y - ndcDy * jPhi.x) / det
    dPhi   = (jTheta.x * ndcDy - jTheta.y * ndcDx) / det
  } else {
    // 退化（切线近乎平行，接近极点），回退到投影分量
    dTheta = jTheta.dot(new THREE.Vector2(ndcDx, ndcDy)) / (jTheta.lengthSq() + 1e-8)
    dPhi   = jPhi.dot(new THREE.Vector2(ndcDx, ndcDy))   / (jPhi.lengthSq()   + 1e-8)
  }

  theta += dTheta
  phi   += dPhi
  theta = Math.max(0.01, Math.min(Math.PI - 0.01, theta))
  updateLightPosition()
}

function onMouseDown(e: MouseEvent) {
  if (!hitLightSphere(e.clientX, e.clientY)) return
  isDragging = true
  lastMouseX = e.clientX
  lastMouseY = e.clientY
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging) {
    renderer.domElement.style.cursor = hitLightSphere(e.clientX, e.clientY) ? 'grab' : 'default'
    return
  }
  renderer.domElement.style.cursor = 'grabbing'
  applyDelta(e.clientX - lastMouseX, e.clientY - lastMouseY)
  lastMouseX = e.clientX
  lastMouseY = e.clientY
}

function onMouseUp() {
  isDragging = false
  renderer.domElement.style.cursor = 'default'
}

function onTouchStart(e: TouchEvent) {
  const touch = e.touches[0]
  if (e.touches.length === 1 && touch) {
    if (!hitLightSphere(touch.clientX, touch.clientY)) return
    isDragging = true
    lastMouseX = touch.clientX
    lastMouseY = touch.clientY
  }
}

function onTouchMove(e: TouchEvent) {
  const touch = e.touches[0]
  if (!isDragging || e.touches.length !== 1 || !touch) return
  applyDelta(touch.clientX - lastMouseX, touch.clientY - lastMouseY)
  lastMouseX = touch.clientX
  lastMouseY = touch.clientY
}

onMounted(() => {
  initScene()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', onResize)
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
  }
})
</script>

<style scoped>
.light-scene-container {
  width: 100%;
  height: 100vh;
  position: relative;
  overflow: hidden;
  background: #111122;
}

.light-scene-container:active {
  cursor: grabbing;
}

.info-panel {
  position: absolute;
  top: 16px;
  left: 16px;
  color: #aaccff;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.5);
  padding: 8px 14px;
  border-radius: 8px;
  pointer-events: none;
  line-height: 1.8;
  font-family: monospace;
}
</style>