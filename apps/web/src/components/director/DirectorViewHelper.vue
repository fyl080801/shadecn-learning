<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { RotateCcw } from "@lucide/vue"
import * as THREE from "three"
import { ViewHelper as ViewHelperBase } from "three/addons/helpers/ViewHelper.js"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { viewportResetRequestId } from "./directorState"

const props = withDefaults(
  defineProps<{ size?: number; showReset?: boolean }>(),
  {
    size: 128,
    showReset: false
  }
)

// 罗盘正交相机视锥体半幅。ViewHelper 端点 Sprite 位于 ±1、半径 0.5，
// 极限铺满 ±1.5；取 1.5 使坐标轴填满画布、无内边距。
const FRUSTUM = 1.5

// 与 ViewHelper.js 内部 color1/color2/color3 一致（X/Y/Z 轴色），
// 负半轴端点默认使用纯黑 + 0.2 透明度；这里改为对应坐标轴色的半透明版本。
const NEG_AXIS_COLORS: Record<string, string> = {
  negX: "#ff4466",
  negY: "#88ff44",
  negZ: "#4488ff"
}
const NEG_AXIS_OPACITY = 0.5
const NEG_AXIS_SPRITE_RADIUS = 14

function createNegAxisSpriteMaterial(color: string): THREE.SpriteMaterial {
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext("2d")!
  context.beginPath()
  context.arc(32, 32, NEG_AXIS_SPRITE_RADIUS, 0, 2 * Math.PI)
  context.closePath()
  context.fillStyle = color
  context.fill()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace

  return new THREE.SpriteMaterial({
    map: texture,
    toneMapped: false,
    opacity: NEG_AXIS_OPACITY
  })
}

const editor = useEditor()

const hostRef = ref<HTMLDivElement | null>(null)
const visibleRef = ref(true)

let renderer: THREE.WebGLRenderer | undefined
let viewHelper: ViewHelperBase | undefined
// 负半轴端点原共享材质（含贴图），替换后需在卸载时一并释放
const negAxisMaterials: THREE.SpriteMaterial[] = []
let rafId = 0
let lastTime = 0
let dirty = true
let compassCamera: THREE.OrthographicCamera | undefined

const savedViewport = new THREE.Vector4()

function isDirectorView(): boolean {
  return editor.viewportCamera === editor.camera
}

function onCameraChanged() {
  // 编辑器相机位姿变化时，罗盘朝向需要刷新
  dirty = true
}

function onViewportCameraChanged() {
  const visible = isDirectorView()
  visibleRef.value = visible
  if (visible) dirty = true
}

// 默认视角方向（与 Editor._DEFAULT_CAMERA 的 position (0,5,10) 一致）。
// 重置仅将相机旋回此方向，不改变缩放（到中心的距离）和轨道中心。
const DEFAULT_VIEW_DIR = new THREE.Vector3(0, 5, 10).normalize()

// ── 轨道视角动画 ──────────────────────────────────────────────
// 与 EditorControls.rotate 行为一致：在球面坐标（theta/phi）上插值，
// 保持 radius 和 center 不变，每帧用 lookAt(center) 更新朝向。
// 同时服务于重置视角与罗盘点击转向。
const ORBIT_DURATION = 0.5 // 秒
const PHI_EPS = 1e-4
let orbitAnimating = false
let orbitElapsed = 0
const orbitCenter = new THREE.Vector3()
const orbitRadius = { value: 0 }
const orbitStart = new THREE.Spherical()
const orbitTarget = new THREE.Spherical()
const _orbitOffset = new THREE.Vector3()

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// 角度插值，走最短弧（处理 ±π 跨越）
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
  return a + diff * t
}

function clampPhi(phi: number): number {
  return THREE.MathUtils.clamp(phi, PHI_EPS, Math.PI - PHI_EPS)
}

// 启动一次轨道动画：保持 radius 与 center 不变，将球面坐标插值到目标。
function startOrbit(targetPhi: number, targetTheta: number) {
  if (!editor.controls || orbitAnimating) return
  orbitAnimating = true
  orbitElapsed = 0
  orbitCenter.copy(editor.controls.center)
  _orbitOffset.copy(editor.camera.position).sub(orbitCenter)
  orbitRadius.value = _orbitOffset.length()
  orbitStart.setFromVector3(_orbitOffset)
  orbitTarget.set(orbitRadius.value, clampPhi(targetPhi), targetTheta)
}

function resetView() {
  if (!editor.controls || orbitAnimating) return
  // 保持距离不变，只将方向旋回默认视角
  _orbitOffset.copy(editor.camera.position).sub(editor.controls.center)
  const radius = _orbitOffset.length()
  _orbitOffset.copy(DEFAULT_VIEW_DIR).multiplyScalar(radius)
  const target = new THREE.Spherical().setFromVector3(_orbitOffset)
  startOrbit(target.phi, target.theta)
}

// 罗盘点击转向（对齐 Blender 导航罗盘行为）：
// - 中心端点（朝向相机的轴）：转到对侧面（相机偏移取反）。
// - 其余端点：旋转到该轴向视角（水平面轴向平视、roll 为 0）。
//   罗盘随相机重新定向，重复点击同一侧可环绕世界向上轴单向旋转。
// 与"视点来源方向"夹角小于 ~41°（对齐度 > 0.75）视为中心端点。
const CENTER_ALIGNMENT = 0.75
const _raycaster = new THREE.Raycaster()
const _pointer = new THREE.Vector2()
const _axisUnit = new THREE.Vector3()
const _targetSpherical = new THREE.Spherical()

function onPointerUp(event: PointerEvent) {
  if (!viewHelper || !visibleRef.value || orbitAnimating) return
  event.stopPropagation()
  const canvas = renderer?.domElement
  if (!canvas || !editor.controls || !compassCamera) return

  const rect = canvas.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top

  // 以自有 ±FRUSTUM 正交相机做射线拾取，画布坐标直接转为 NDC。
  const ndcX = (px / props.size) * 2 - 1
  const ndcY = -(py / props.size) * 2 + 1
  _raycaster.setFromCamera(_pointer.set(ndcX, ndcY), compassCamera)

  // 同步罗盘朝向当前相机，确保端点世界坐标与视觉一致后再拾取
  viewHelper.quaternion.copy(editor.camera.quaternion).invert()
  viewHelper.updateMatrixWorld(true)

  // 仅取带 userData.type 的轴向端点 Sprite，排除坐标轴与背景板
  const hits = _raycaster.intersectObjects(viewHelper.children, true)
  const axisHit = hits.find((hit) => hit.object.userData?.type)
  if (!axisHit) return

  // 命中端点的本地坐标即其世界轴向单位向量（如 +X=(1,0,0)）。
  _axisUnit.copy(axisHit.object.position).normalize()

  // 当前相机偏移及其与该轴的对齐度
  _orbitOffset.copy(editor.camera.position).sub(editor.controls.center)
  const radius = _orbitOffset.length()
  const alignment = _orbitOffset.dot(_axisUnit) / radius

  if (Math.abs(alignment) > CENTER_ALIGNMENT) {
    // 中心端点：转到对侧面。目标方向取该轴的规范反向（而非当前偏移取反），
    // 避免沿用当前非水平的 phi 导致翻转后仍是斜视角，无法对齐水平。
    _orbitOffset.copy(_axisUnit).multiplyScalar(-Math.sign(alignment) * radius)
    _targetSpherical.setFromVector3(_orbitOffset)
    startOrbit(_targetSpherical.phi, _targetSpherical.theta)
  } else {
    // 旋转到该轴向视角：水平面轴向平视（phi=π/2），roll 为 0
    _orbitOffset.copy(_axisUnit).multiplyScalar(radius)
    _targetSpherical.setFromVector3(_orbitOffset)
    startOrbit(_targetSpherical.phi, _targetSpherical.theta)
  }
}

function onPointerDown(event: PointerEvent) {
  // 阻止指针事件穿透到下方视口的轨道控制器
  event.stopPropagation()
}

function loop(time: number) {
  rafId = requestAnimationFrame(loop)
  if (!viewHelper || !renderer) return

  const delta = lastTime ? (time - lastTime) / 1000 : 0
  lastTime = time

  if (orbitAnimating) {
    orbitElapsed += delta
    const t = Math.min(orbitElapsed / ORBIT_DURATION, 1)
    const eased = easeInOutCubic(t)
    // 球面坐标插值：只改 theta/phi，radius 和 center 保持不变
    const phi = THREE.MathUtils.lerp(orbitStart.phi, orbitTarget.phi, eased)
    const theta = lerpAngle(orbitStart.theta, orbitTarget.theta, eased)
    _orbitOffset.setFromSphericalCoords(orbitRadius.value, phi, theta)
    editor.camera.position.copy(orbitCenter).add(_orbitOffset)
    editor.camera.lookAt(orbitCenter)
    editor.signals.cameraChanged.dispatch(editor.camera)
    dirty = true
    if (t >= 1) orbitAnimating = false
  }

  if (dirty && visibleRef.value) {
    dirty = false
    renderer.clear()
    viewHelper.render(renderer)
  }
}

onMounted(() => {
  const canvas = document.createElement("canvas")
  hostRef.value?.appendChild(canvas)

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setClearColor(0x000000, 0)
  renderer.autoClear = false
  renderer.setSize(props.size, props.size, true)

  // 自有正交相机，视锥体收紧至 ±FRUSTUM，消除默认 ±2 的留白
  compassCamera = new THREE.OrthographicCamera(
    -FRUSTUM,
    FRUSTUM,
    FRUSTUM,
    -FRUSTUM,
    0,
    4
  )
  compassCamera.position.set(0, 0, 2)

  viewHelper = new ViewHelperBase(editor.camera, canvas)
  // 画布尺寸由 props.size 控制；拾取由自有 compassCamera 完成，不依赖 location
  viewHelper.location.left = 0
  viewHelper.location.top = 0
  // 与轨道控制器共享 center 引用，点击轴向时相机绕同一目标旋转
  viewHelper.center = editor.controls.center
  // 正交轴（+X/+Y/+Z）端点显示字母标签；负半轴端点保持无标签的暗点。
  viewHelper.setLabelStyle(undefined, "#ffffff")
  viewHelper.setLabels("X", "Y", "Z")

  // 负半轴端点默认三个共享同一个纯黑材质（ViewHelper.dispose 不会释放它），
  // 这里替换为各自坐标轴颜色的半透明材质，新旧材质均登记以便卸载时释放
  let sharedNegMaterial: THREE.SpriteMaterial | undefined
  viewHelper.children.forEach((child) => {
    const type = (child as THREE.Sprite).userData?.type as string | undefined
    // 只处理负半轴端点（带 type 且在色表里的那三个）
    const color = type ? NEG_AXIS_COLORS[type] : undefined
    if (!color) return
    const sprite = child as THREE.Sprite
    sharedNegMaterial = sprite.material
    const material = createNegAxisSpriteMaterial(color)
    sprite.material = material
    negAxisMaterials.push(material)
  })
  if (sharedNegMaterial) negAxisMaterials.push(sharedNegMaterial)

  // 覆盖默认 render：以 props.size 设置视口、用自有 ±FRUSTUM 相机渲染，
  // 使罗盘填满整个画布
  viewHelper.render = (r: THREE.WebGLRenderer) => {
    const helper = viewHelper!
    helper.quaternion.copy(editor.camera.quaternion).invert()
    helper.updateMatrixWorld()
    r.getViewport(savedViewport)
    r.clearDepth()
    r.setViewport(0, 0, props.size, props.size)
    r.render(helper, compassCamera!)
    r.setViewport(
      savedViewport.x,
      savedViewport.y,
      savedViewport.z,
      savedViewport.w
    )
  }

  visibleRef.value = isDirectorView()

  canvas.addEventListener("pointerup", onPointerUp)
  canvas.addEventListener("pointerdown", onPointerDown)

  editor.signals.cameraChanged.add(onCameraChanged)
  editor.signals.viewportCameraChanged.add(onViewportCameraChanged)
  editor.signals.cameraResetted.add(onViewportCameraChanged)

  rafId = requestAnimationFrame(loop)
})

watch(
  () => props.size,
  (size) => {
    renderer?.setSize(size, size, true)
    dirty = true
  }
)

// DirectorTransformControls / DirectorViewControls 的"重置视角"按钮通过该令牌触发，两者非父子关系
// （所以罗盘收起时只能 v-show，卸载了就没人接这个令牌）
watch(viewportResetRequestId, () => resetView())

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)

  editor.signals.cameraChanged.remove(onCameraChanged)
  editor.signals.viewportCameraChanged.remove(onViewportCameraChanged)
  editor.signals.cameraResetted.remove(onViewportCameraChanged)

  if (viewHelper) viewHelper.dispose()
  negAxisMaterials.forEach((material) => {
    material.map?.dispose()
    material.dispose()
  })
  negAxisMaterials.length = 0
  if (renderer) {
    renderer.setAnimationLoop(null)
    renderer.dispose()
  }
})
</script>

<template>
  <div
    v-show="visibleRef"
    class="pointer-events-auto z-10 flex flex-col items-center gap-1"
  >
    <div ref="hostRef" />
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          v-if="showReset"
          variant="ghost"
          size="icon"
          class="view-helper-reset-btn"
          aria-label="重置视角"
          @click="resetView"
        >
          <RotateCcw class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">重置视角</TooltipContent>
    </Tooltip>
  </div>
</template>

<style scoped>
.view-helper-reset-btn {
  /* 浮在 3D 画布上，不跟随明暗主题。 */
  color: rgba(255, 255, 255, 0.85);
  background-color: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  border-radius: 999px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.view-helper-reset-btn:hover {
  background-color: rgba(255, 255, 255, 0.15);
  color: #fff;
}
</style>
