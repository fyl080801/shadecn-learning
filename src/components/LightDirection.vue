<template>
  <canvas ref="canvasRef" class="rounded-lg"></canvas>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue"
import * as THREE from "three"

const canvasRef = ref<HTMLCanvasElement | null>(null)

const emit = defineEmits<{
  (e: "change", direction: { x: number; y: number; z: number }): void
}>()

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let animationId: number

const SPHERE_RADIUS = 2
const POINT_RADIUS = 0.12
const MOVE_SPEED = 0.008

// Spherical coordinates for the drag point
const pointTheta = ref(0) // longitude
const pointPhi = ref(Math.PI / 4) // colatitude (0=top, PI=bottom)

// Drag state
let isDragging = false
let dragStartX = 0
let dragStartY = 0

const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()

interface DragPoint {
  mesh: THREE.Mesh
  ring: THREE.Mesh
  glowRing: THREE.Mesh
}

const points: DragPoint[] = []

// Convert spherical coords to 3D position
function sphericalToPosition(theta: number, phi: number): THREE.Vector3 {
  const x = SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta)
  const y = SPHERE_RADIUS * Math.cos(phi)
  const z = SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
  return new THREE.Vector3(x, y, z)
}

function updatePointPosition() {
  const pos = sphericalToPosition(pointTheta.value, pointPhi.value)
  for (const p of points) {
    p.mesh.position.copy(pos)
    p.ring.position.copy(pos)
    p.glowRing.position.copy(pos)

    // Adjust appearance based on front/back
    const isBack = pos.clone().normalize().dot(camera.position.clone().normalize()) < 0
    const mat = p.mesh.material as THREE.MeshPhysicalMaterial
    mat.opacity = isBack ? 0.4 : 1.0
    mat.transparent = true

    const ringMat = p.ring.material as THREE.MeshBasicMaterial
    ringMat.opacity = isBack ? 0.15 : 0.3

    const glowMat = p.glowRing.material as THREE.MeshBasicMaterial
    glowMat.opacity = isBack ? 0.1 : 0.2
  }

  // Emit direction
  const direction = pos.clone().normalize()
  emit("change", { x: direction.x, y: direction.y, z: direction.z })
}

function onPointerDown(event: PointerEvent) {
  if (!canvasRef.value) return
  const rect = canvasRef.value.getBoundingClientRect()
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

  raycaster.setFromCamera(mouse, camera)

  // Check intersection with drag point meshes
  const pointMeshes = points.map((p) => p.mesh)
  const intersects = raycaster.intersectObjects(pointMeshes)
  if (intersects.length > 0) {
    isDragging = true
    dragStartX = event.clientX
    dragStartY = event.clientY
    canvasRef.value.setPointerCapture(event.pointerId)
  }
}

function onPointerMove(event: PointerEvent) {
  if (!isDragging) return
  const dx = event.clientX - dragStartX
  const dy = event.clientY - dragStartY
  dragStartX = event.clientX
  dragStartY = event.clientY

  // Update spherical coords based on mouse delta
  pointTheta.value -= dx * MOVE_SPEED
  pointPhi.value = Math.max(0.05, Math.min(Math.PI - 0.05, pointPhi.value + dy * MOVE_SPEED))

  updatePointPosition()
}

function onPointerUp() {
  isDragging = false
}

function init() {
  if (!canvasRef.value) return

  const width = 400
  const height = 400

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
    alpha: true
  })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio)

  // Scene
  scene = new THREE.Scene()

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
  camera.position.set(0, 0, 6)
  camera.lookAt(0, 0, 0)

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.5)
  scene.add(ambientLight)

  const dirLight = new THREE.DirectionalLight(0xffffff, 2)
  dirLight.position.set(5, 5, 5)
  scene.add(dirLight)

  // Semi-transparent sphere
  const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 64)
  const sphereMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xcccccc,
    transparent: true,
    opacity: 0.2,
    roughness: 0.1,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
  scene.add(sphere)

  // Draggable point on sphere surface
  createDragPoint(0xff4444)

  // Coordinate axes (subtle)
  createAxisLine(
    new THREE.Vector3(-SPHERE_RADIUS * 1.3, 0, 0),
    new THREE.Vector3(SPHERE_RADIUS * 1.3, 0, 0),
    0xff6666
  )
  createAxisLine(
    new THREE.Vector3(0, -SPHERE_RADIUS * 1.3, 0),
    new THREE.Vector3(0, SPHERE_RADIUS * 1.3, 0),
    0x66cc66
  )
  createAxisLine(
    new THREE.Vector3(0, 0, -SPHERE_RADIUS * 1.3),
    new THREE.Vector3(0, 0, SPHERE_RADIUS * 1.3),
    0x6688ff
  )

  // Initial position
  updatePointPosition()

  // Events
  canvasRef.value.addEventListener("pointerdown", onPointerDown)
  canvasRef.value.addEventListener("pointermove", onPointerMove)
  canvasRef.value.addEventListener("pointerup", onPointerUp)
}

function createDragPoint(color: number) {
  const pos = sphericalToPosition(pointTheta.value, pointPhi.value)

  // Main point sphere
  const geometry = new THREE.SphereGeometry(POINT_RADIUS, 32, 32)
  const material = new THREE.MeshPhysicalMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.6,
    roughness: 0.2,
    metalness: 0.5,
    transparent: true,
    opacity: 1.0
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(pos)
  scene.add(mesh)

  // Inner ring
  const ringGeometry = new THREE.RingGeometry(POINT_RADIUS * 1.5, POINT_RADIUS * 2.2, 32)
  const ringMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  const ring = new THREE.Mesh(ringGeometry, ringMaterial)
  ring.position.copy(pos)
  ring.lookAt(new THREE.Vector3(0, 0, 0))
  scene.add(ring)

  // Outer glow ring
  const glowGeometry = new THREE.RingGeometry(POINT_RADIUS * 2.5, POINT_RADIUS * 3.5, 32)
  const glowMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  const glowRing = new THREE.Mesh(glowGeometry, glowMaterial)
  glowRing.position.copy(pos)
  glowRing.lookAt(new THREE.Vector3(0, 0, 0))
  scene.add(glowRing)

  points.push({ mesh, ring, glowRing })
}

function createAxisLine(start: THREE.Vector3, end: THREE.Vector3, color: number) {
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3
  })
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end])
  const line = new THREE.Line(geometry, material)
  scene.add(line)
}

function animate() {
  animationId = requestAnimationFrame(animate)

  // Keep rings facing the camera
  for (const p of points) {
    p.ring.lookAt(camera.position)
    p.glowRing.lookAt(camera.position)
  }

  renderer.render(scene, camera)
}

onMounted(() => {
  init()
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  if (canvasRef.value) {
    canvasRef.value.removeEventListener("pointerdown", onPointerDown)
    canvasRef.value.removeEventListener("pointermove", onPointerMove)
    canvasRef.value.removeEventListener("pointerup", onPointerUp)
  }
  renderer?.dispose()
})
</script>