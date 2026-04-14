<template>
  <canvas
    ref="canvasRef"
    class="rounded-lg"
    :style="{
      cursor: isDragging ? 'grabbing' : isHovering ? 'grab' : 'default'
    }"
  ></canvas>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue"
import * as THREE from "three"

const canvasRef = ref<HTMLCanvasElement | null>(null)
const isDragging = ref(false)
const isHovering = ref(false)

const emit = defineEmits<{
  (e: "change", direction: { x: number; y: number; z: number }): void
}>()

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let animationId: number

const SPHERE_RADIUS = 2
const POINT_RADIUS = 0.12

// Light cone mesh (visual gradient from drag point to rectangle)
let coneMesh: THREE.Mesh
let coneMaterial: THREE.ShaderMaterial

// Spherical coordinates for the drag point
const pointTheta = ref(0) // longitude
const pointPhi = ref(Math.PI / 4) // colatitude (0=top, PI=bottom)

// Raycaster for click detection only
const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()

let lastPointerX = 0
let lastPointerY = 0

interface DragPoint {
  mesh: THREE.Mesh
  glow: THREE.Mesh
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

  const lightDir = pos.clone().normalize().negate()
  for (const p of points) {
    p.mesh.position.copy(pos)
    p.glow.position.copy(pos)
    // Update light direction uniform for gradient shading
    const mat = p.mesh.material as THREE.ShaderMaterial
    mat.uniforms.uLightDir.value.copy(lightDir)
    const glowMat = p.glow.material as THREE.ShaderMaterial
    glowMat.uniforms.uLightDir.value.copy(lightDir)
  }

  // Update cone position and orientation to follow the drag point
  // Cone center = midpoint between drag point and origin
  coneMesh.position.copy(pos).multiplyScalar(0.5)
  // Orient cone so local Y axis points from center toward drag point
  const targetDir = pos.clone().normalize()
  coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), targetDir)

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
    isDragging.value = true
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    canvasRef.value.setPointerCapture(event.pointerId)
  }
}

function onPointerMove(event: PointerEvent) {
  if (!canvasRef.value) return

  // Hover detection for cursor
  if (!isDragging.value) {
    const rect = canvasRef.value.getBoundingClientRect()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const pointMeshes = points.map((p) => p.mesh)
    const intersects = raycaster.intersectObjects(pointMeshes)
    isHovering.value = intersects.length > 0
    return
  }

  // --- Dragging: delta-based movement (consistent across front/back) ---
  const dx = event.clientX - lastPointerX
  const dy = event.clientY - lastPointerY
  lastPointerX = event.clientX
  lastPointerY = event.clientY

  const speed = 0.008
  pointTheta.value -= dx * speed
  pointPhi.value = Math.max(
    0.05,
    Math.min(Math.PI - 0.05, pointPhi.value + dy * speed)
  )

  updatePointPosition()
}

function onPointerUp() {
  isDragging.value = false
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
  scene.background = new THREE.Color(0x1a1a2e)

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
  camera.position.set(0, 0, 6)
  camera.lookAt(0, 0, 0)

  // Hemisphere light for subtle shading on the rectangle
  const hemiLight = new THREE.HemisphereLight(0x9999ff, 0x222244, 1.5)
  scene.add(hemiLight)

  // Bubble-effect sphere: edge ring visible, center fully transparent
  const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 64)
  const sphereMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: {
      uColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uEdgeStart: { value: 0 },
      uEdgeWidth: { value: 1 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uEdgeStart;
      uniform float uEdgeWidth;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        float fresnel = 1.0 - dot(vNormal, vViewDir);
        float ring = smoothstep(uEdgeStart, uEdgeStart + uEdgeWidth, fresnel);
        float alpha = ring * 0.55;
        gl_FragColor = vec4(uColor, alpha);
      }
    `
  })
  const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
  scene.add(sphere)

  // Invisible sphere for click detection (front face only)
  const sphereForHitTest = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS, 64, 64),
    new THREE.MeshBasicMaterial({ visible: false })
  )
  scene.add(sphereForHitTest)

  // Reference rectangle in the center
  const rectWidth = 1.6
  const rectHeight = 1.2
  const rectGeometry = new THREE.PlaneGeometry(rectWidth, rectHeight)
  const rectMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a3a5c,
    roughness: 0.7,
    metalness: 0.0,
    side: THREE.DoubleSide
  })
  const rectMesh = new THREE.Mesh(rectGeometry, rectMaterial)
  scene.add(rectMesh)

  // Rectangle border frame
  const borderGeometry = new THREE.EdgesGeometry(rectGeometry)
  const borderMaterial = new THREE.LineBasicMaterial({ color: 0x6666aa })
  const borderLine = new THREE.LineSegments(borderGeometry, borderMaterial)
  scene.add(borderLine)

  // Light cone: visual gradient from drag point to rectangle
  const coneHeight = SPHERE_RADIUS
  const coneGeometry = new THREE.CylinderGeometry(
    0.05,
    0.9,
    coneHeight,
    32,
    1,
    true
  )
  coneMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uOpacity: { value: 1.0 }
    },
    vertexShader: `
      varying float vProgress;
      void main() {
        // position.y ranges from -height/2 to +height/2
        // Normalize to 0-1: 0 = bottom (rectangle), 1 = top (drag point)
        vProgress = (position.y + ${(coneHeight / 2).toFixed(1)}) / ${coneHeight.toFixed(1)};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vProgress;
      uniform float uOpacity;
      void main() {
        float alpha = smoothstep(0.0, 1.0, vProgress) * 0.4 * uOpacity;
        gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
      }
    `
  })
  coneMesh = new THREE.Mesh(coneGeometry, coneMaterial)
  scene.add(coneMesh)

  // Draggable point on sphere surface
  createDragPoint()

  // Z-axis line (depth)
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

function createDragPoint() {
  const pos = sphericalToPosition(pointTheta.value, pointPhi.value)

  // Dark sphere with light-facing highlight gradient
  const geometry = new THREE.SphereGeometry(POINT_RADIUS, 32, 32)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: pos.clone().normalize().negate() },
      uBrightColor: { value: new THREE.Color(0.9, 0.95, 1.0) },
      uDarkColor: { value: new THREE.Color(0.05, 0.05, 0.1) }
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uLightDir;
      uniform vec3 uBrightColor;
      uniform vec3 uDarkColor;
      varying vec3 vNormal;
      void main() {
        float facing = dot(vNormal, uLightDir);
        float t = smoothstep(-0.8, 1.0, facing);
        vec3 color = mix(uDarkColor, uBrightColor, t);
        gl_FragColor = vec4(color, 1.0);
      }
    `
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(pos)
  scene.add(mesh)

  // Atmospheric glow: edge-only, bright toward sphere center, dark on far side
  const GLOW_POWER = 2.0 // edge tightness (lower = softer spread)
  const GLOW_INTENSITY = 1.2 // peak brightness

  const glowRadius = POINT_RADIUS
  const glowGeometry = new THREE.SphereGeometry(glowRadius, 32, 32)
  const glowMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uGlowColor: { value: new THREE.Color(0.6, 0.7, 1.0) },
      uLightDir: { value: pos.clone().normalize().negate() },
      uPower: { value: GLOW_POWER },
      uIntensity: { value: GLOW_INTENSITY }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uGlowColor;
      uniform vec3 uLightDir;
      uniform float uPower;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        float rim = 1.0 - dot(vNormal, vViewDir);
        float edgeMask = pow(max(rim, 0.0), uPower);
        float facing = dot(vNormal, uLightDir);
        float dirMask = smoothstep(-0.2, 1.0, facing);
        float alpha = edgeMask * dirMask * uIntensity;
        gl_FragColor = vec4(uGlowColor, alpha);
      }
    `
  })
  const glow = new THREE.Mesh(glowGeometry, glowMaterial)
  glow.position.copy(pos)
  scene.add(glow)

  points.push({ mesh, glow })
}

function createAxisLine(
  start: THREE.Vector3,
  end: THREE.Vector3,
  color: number
) {
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
