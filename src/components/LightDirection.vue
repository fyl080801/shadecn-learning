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
import { ref, onMounted, onBeforeUnmount, watch } from "vue"
import * as THREE from "three"

const props = withDefaults(
  defineProps<{
    viewMode?: "front" | "perspective"
    snap?: boolean
  }>(),
  { viewMode: "front", snap: false }
)

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

// Camera configurations for each view mode
const CAMERA_CONFIGS = {
  front: new THREE.Vector3(0, 0, 6),
  perspective: new THREE.Vector3(4, 3, 5)
} as const
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0)
let cameraTargetPos = CAMERA_CONFIGS.front.clone()

watch(
  () => props.viewMode,
  (mode) => {
    cameraTargetPos.copy(CAMERA_CONFIGS[mode])
  }
)
let hemiLight: THREE.HemisphereLight
let pointLight: THREE.PointLight
let currentIntensity = 0.3
let sphereMaterial: THREE.ShaderMaterial
const gridLineMaterials: THREE.ShaderMaterial[] = []
const dotMaterials: THREE.ShaderMaterial[] = []

const SPHERE_RADIUS = 2
const POINT_RADIUS = 0.12
const POINT_OFFSET = 0.1
const CONE_LENGTH = 2.1 // 锥体底部到光源的距离

// Light cone mesh (visual gradient from drag point to rectangle)
let coneMesh: THREE.Mesh
let coneMaterial: THREE.ShaderMaterial

// Spherical coordinates for the drag point
const pointTheta = ref(Math.PI / 2) // longitude — 面向相机
const pointPhi = ref(Math.PI / 2) // colatitude — 赤道上

// Raycaster for click detection only
const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()

let lastPointerX = 0
let lastPointerY = 0

// Snap-to-grid state
let isSnapping = false
let snapTargetTheta = 0
let snapTargetPhi = Math.PI / 2
const SNAP_LONGITUDES = [
  0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4,
  Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4
]
const SNAP_LATITUDES = [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]

function findNearestSnapPoint(currentTheta: number, currentPhi: number): { theta: number; phi: number } {
  const currentPos = sphericalToPosition(currentTheta, currentPhi)
  let minDist = Infinity
  let bestTheta = currentTheta
  let bestPhi = currentPhi

  for (const theta of SNAP_LONGITUDES) {
    for (const phi of SNAP_LATITUDES) {
      const pos = sphericalToPosition(theta, phi)
      const dist = pos.distanceTo(currentPos)
      if (dist < minDist) {
        minDist = dist
        bestTheta = theta
        bestPhi = phi
      }
    }
  }

  // Check poles
  const northDist = new THREE.Vector3(0, SPHERE_RADIUS, 0).distanceTo(currentPos)
  const southDist = new THREE.Vector3(0, -SPHERE_RADIUS, 0).distanceTo(currentPos)
  if (northDist < minDist) {
    bestTheta = currentTheta
    bestPhi = 0.05
  } else if (southDist < minDist) {
    bestTheta = currentTheta
    bestPhi = Math.PI - 0.05
  }

  return { theta: bestTheta, phi: bestPhi }
}

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
  const surfacePos = sphericalToPosition(pointTheta.value, pointPhi.value)
  const pos = surfacePos
    .clone()
    .normalize()
    .multiplyScalar(SPHERE_RADIUS + POINT_OFFSET)

  const lightDir = surfacePos.clone().normalize().negate()
  for (const p of points) {
    p.mesh.position.copy(pos)
    p.glow.position.copy(pos)
    const mat = p.mesh.material as THREE.ShaderMaterial
    mat.uniforms.uLightDir!.value.copy(lightDir)
    const glowMat = p.glow.material as THREE.ShaderMaterial
    glowMat.uniforms.uLightDir!.value.copy(lightDir)
  }

  // Update cone position and orientation to follow the drag point
  // Cone: bottom at world origin, top at light position
  // Center of cone in world space = midpoint = direction * (height/2)
  const offsetRadius = SPHERE_RADIUS + POINT_OFFSET
  const dir = surfacePos.clone().normalize()
  coneMesh.position.copy(dir.clone().multiplyScalar(offsetRadius * 0.5))
  coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)

  // Move point light to follow the drag point
  pointLight.position.copy(pos)

  // Emit direction
  const direction = surfacePos.clone().normalize()
  emit("change", { x: direction.x, y: direction.y, z: direction.z })
}

function onPointerDown(event: PointerEvent) {
  isSnapping = false
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
  if (props.snap) {
    const nearest = findNearestSnapPoint(pointTheta.value, pointPhi.value)
    snapTargetTheta = nearest.theta
    snapTargetPhi = nearest.phi
    isSnapping = true
  }
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
  camera.lookAt(CAMERA_TARGET)

  // Hemisphere light for subtle shading on the rectangle
  hemiLight = new THREE.HemisphereLight(0x9999ff, 0x222244, 0.3)
  scene.add(hemiLight)

  // Point light at drag point — intensity reacts to dragging
  pointLight = new THREE.PointLight(0xffffff, 0.3, 20)
  scene.add(pointLight)

  // Bubble-effect sphere: edge ring visible, center fully transparent
  const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 64)
  sphereMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: {
      uColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uEdgeStart: { value: 0 },
      uEdgeWidth: { value: 1 },
      uAlphaScale: { value: 1.0 }
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
      uniform float uAlphaScale;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        float fresnel = 1.0 - dot(vNormal, vViewDir);
        float ring = smoothstep(uEdgeStart, uEdgeStart + uEdgeWidth, fresnel);
        float alpha = ring * 0.55 * uAlphaScale;
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

  // Grid line shader: brightness varies with proximity to light
  function createGridLine(linePoints: THREE.Vector3[]) {
    const geom = new THREE.BufferGeometry().setFromPoints(linePoints)
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uLightPos: { value: new THREE.Vector3() } },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vWorldPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uLightPos;
        varying vec3 vWorldPos;
        void main() {
          float dist = distance(vWorldPos, uLightPos);
          float proximity = 1.0 - smoothstep(0.0, 1.5, dist);
          float alpha = 0.05 + proximity * 0.55;
          vec3 color = mix(vec3(0.15, 0.2, 0.45), vec3(1.0), proximity * 0.7);
          gl_FragColor = vec4(color, alpha);
        }
      `
    })
    gridLineMaterials.push(mat)
    const line = new THREE.Line(geom, mat)
    scene.add(line)
  }

  // Equator line (central latitude)
  const equatorPoints: THREE.Vector3[] = []
  const equatorSegments = 128
  for (let i = 0; i <= equatorSegments; i++) {
    const angle = (i / equatorSegments) * Math.PI * 2
    equatorPoints.push(
      new THREE.Vector3(
        SPHERE_RADIUS * Math.cos(angle),
        0,
        SPHERE_RADIUS * Math.sin(angle)
      )
    )
  }
  createGridLine(equatorPoints)

  // Longitude lines (full great circles — front and back halves)
  function createLongitudeLine(theta: number) {
    const segments = 128
    const points: THREE.Vector3[] = []
    // Front half: north pole → equator → south pole
    for (let i = 0; i <= segments; i++) {
      const phi = (i / segments) * Math.PI
      points.push(sphericalToPosition(theta, phi))
    }
    // Back half: south pole → equator (opposite side) → north pole
    for (let i = segments - 1; i >= 1; i--) {
      const phi = (i / segments) * Math.PI
      points.push(sphericalToPosition(theta + Math.PI, phi))
    }
    createGridLine(points)
  }

  const longitudeThetas = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]
  for (const theta of longitudeThetas) {
    createLongitudeLine(theta)
  }

  // Latitude lines near the poles
  const polarLatitudes = [Math.PI / 4, (3 * Math.PI) / 4] // colatitudes: 45° and 135°
  for (const phi of polarLatitudes) {
    const r = SPHERE_RADIUS * Math.sin(phi)
    const y = SPHERE_RADIUS * Math.cos(phi)
    const latPoints: THREE.Vector3[] = []
    for (let i = 0; i <= equatorSegments; i++) {
      const angle = (i / equatorSegments) * Math.PI * 2
      latPoints.push(new THREE.Vector3(r * Math.cos(angle), y, r * Math.sin(angle)))
    }
    createGridLine(latPoints)
  }

  // Intersection dots at longitude-latitude crossings (front + back)
  const dotRadius = 0.05
  const dotGeometry = new THREE.SphereGeometry(dotRadius, 16, 16)
  const gridLongitudes = [
    0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4,
    Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4
  ]
  const gridLatitudes = [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]

  function createDot(pos: THREE.Vector3) {
    const dotMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLightPos: { value: new THREE.Vector3() },
        uDotCenter: { value: pos.clone() }
      },
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uLightPos;
        uniform vec3 uDotCenter;
        void main() {
          float dist = distance(uDotCenter, uLightPos);
          float proximity = 1.0 - smoothstep(0.0, 2.0, dist);
          float alpha = 0.06 + proximity * 0.94;
          vec3 color = mix(vec3(0.15, 0.2, 0.4), vec3(1.0), proximity);
          gl_FragColor = vec4(color, alpha);
        }
      `
    })
    dotMaterials.push(dotMat)
    const dot = new THREE.Mesh(dotGeometry, dotMat)
    dot.position.copy(pos)
    scene.add(dot)
  }

  // Grid intersection dots (8 longitudes x 3 latitudes = 24 crossings)
  for (const theta of gridLongitudes) {
    for (const phi of gridLatitudes) {
      createDot(sphericalToPosition(theta, phi))
    }
  }

  // Pole dots
  createDot(new THREE.Vector3(0, SPHERE_RADIUS, 0))        // north pole
  createDot(new THREE.Vector3(0, -SPHERE_RADIUS, 0))       // south pole

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

  // Light cone: visual gradient from drag point to rectangle (partial, ~350° arc with a gap)
  const rectHalfDiag =
    Math.sqrt(rectWidth * rectWidth + rectHeight * rectHeight) / 2
  const coneHeight = CONE_LENGTH
  const coneBottomRadius = rectHalfDiag * 0.8
  const coneThetaLength = Math.PI * 2 * 0.9999 // slight gap for seam
  const coneGapAngle = Math.PI * 2 * 0.0001
  const coneThetaStart = Math.PI + coneGapAngle // seam on -Z side, opening clockwise
  const coneGeometry = new THREE.CylinderGeometry(
    0.02,
    coneBottomRadius,
    coneHeight,
    128,
    1,
    true,
    coneThetaStart,
    coneThetaLength
  )
  coneMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uOpacity: { value: 1 }
    },
    vertexShader: `
      varying float vProgress;
      varying float vAngle;
      void main() {
        vProgress = (position.y + ${(coneHeight / 2).toFixed(1)}) / ${coneHeight.toFixed(1)};
        vAngle = atan(position.x, position.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vProgress;
      varying float vAngle;
      uniform float uOpacity;
      void main() {
        float sideBias = 0.8 + 0.8 * cos(vAngle);
        float alpha = smoothstep(0.0, 1.0, vProgress) * (0.2 + 0.8 * sideBias) * uOpacity;
        gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
      }
    `
  })
  coneMesh = new THREE.Mesh(coneGeometry, coneMaterial)
  scene.add(coneMesh)

  // Draggable point on sphere surface
  createDragPoint()

  // Initial position
  updatePointPosition()

  // Events
  canvasRef.value.addEventListener("pointerdown", onPointerDown)
  canvasRef.value.addEventListener("pointermove", onPointerMove)
  canvasRef.value.addEventListener("pointerup", onPointerUp)
}

function createDragPoint() {
  const surfacePos = sphericalToPosition(pointTheta.value, pointPhi.value)
  const pos = surfacePos
    .clone()
    .normalize()
    .multiplyScalar(SPHERE_RADIUS + POINT_OFFSET)

  // Dark sphere lit from one side (toward sphere center = light direction)
  const geometry = new THREE.SphereGeometry(POINT_RADIUS, 32, 32)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: surfacePos.clone().normalize().negate() },
      uBrightColor: { value: new THREE.Color(0.9, 0.95, 1.0) },
      uDarkColor: { value: new THREE.Color(0.05, 0.05, 0.1) }
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      void main() {
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uLightDir;
      uniform vec3 uBrightColor;
      uniform vec3 uDarkColor;
      varying vec3 vWorldNormal;
      void main() {
        float facing = dot(vWorldNormal, normalize(uLightDir));
        float t = smoothstep(-0.3, 1.0, facing);
        vec3 color = mix(uDarkColor, uBrightColor, t);
        gl_FragColor = vec4(color, 1.0);
      }
    `
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(pos)
  scene.add(mesh)

  // Atmospheric glow: only on the lit side (toward sphere center)
  const GLOW_POWER = 2.0
  const GLOW_INTENSITY = 1.2

  const glowRadius = POINT_RADIUS * 1.8
  const glowGeometry = new THREE.SphereGeometry(glowRadius, 32, 32)
  const glowMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uGlowColor: { value: new THREE.Color(0.6, 0.7, 1.0) },
      uLightDir: { value: surfacePos.clone().normalize().negate() },
      uPower: { value: GLOW_POWER },
      uIntensity: { value: GLOW_INTENSITY }
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
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
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        float rim = 1.0 - dot(vWorldNormal, vViewDir);
        float edgeMask = pow(max(rim, 0.0), uPower);
        float facing = dot(vWorldNormal, normalize(uLightDir));
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
  return line
}

function animate() {
  animationId = requestAnimationFrame(animate)

  // Smooth camera transition
  camera.position.lerp(cameraTargetPos, 0.06)
  camera.lookAt(CAMERA_TARGET)

  const targetIntensity = isDragging.value ? 1.2 : 0.6
  currentIntensity += (targetIntensity - currentIntensity) * 0.08

  hemiLight.intensity = currentIntensity * 0.75
  pointLight.intensity = currentIntensity
  coneMaterial.uniforms.uOpacity!.value = 0.15 + currentIntensity * 0.4

  // Sphere fades when dragging (light focused), bright when idle
  const sphereAlpha = isDragging.value ? 0.3 : 1.0
  sphereMaterial.uniforms.uAlphaScale!.value +=
    (sphereAlpha - sphereMaterial.uniforms.uAlphaScale!.value) * 0.08

  for (const p of points) {
    const glowMat = p.glow.material as THREE.ShaderMaterial
    glowMat.uniforms.uIntensity!.value = 0.4 + currentIntensity * 0.6
  }

  // Update grid lines and dots with current light position
  const lightPos = pointLight.position
  for (const mat of gridLineMaterials) {
    mat.uniforms.uLightPos!.value.copy(lightPos)
  }
  for (const mat of dotMaterials) {
    mat.uniforms.uLightPos!.value.copy(lightPos)
  }

  // Snap animation: lerp toward nearest grid point
  if (isSnapping) {
    let thetaDiff = snapTargetTheta - pointTheta.value
    thetaDiff = ((thetaDiff % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
    pointTheta.value += thetaDiff * 0.15
    pointPhi.value += (snapTargetPhi - pointPhi.value) * 0.15

    if (Math.abs(thetaDiff) < 0.001 && Math.abs(snapTargetPhi - pointPhi.value) < 0.001) {
      pointTheta.value = snapTargetTheta
      pointPhi.value = snapTargetPhi
      isSnapping = false
    }
    updatePointPosition()
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
