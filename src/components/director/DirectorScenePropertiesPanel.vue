<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import * as THREE from "three"

import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import TextureField from "@/components/three-editor/TextureField.vue"
import { showCharacterLabels } from "./directorState"

const editor = useEditor()
const signals = editor.signals
const scene = editor.scene

function requestRender() {
  signals.sceneGraphChanged.dispatch()
}

// 仅在无选中对象时显示——保持挂载（用 v-show 而非 v-if），
// 使背景监视器在用户选中图形、此面板让位于对象面板时继续运行。
const selected = ref<any>(editor.selected)
function onObjectSelected(object: any) {
  selected.value = object
}
onMounted(() => signals.objectSelected.add(onObjectSelected))
onBeforeUnmount(() => signals.objectSelected.remove(onObjectSelected))

// ----- 场景变换 -----
//
// 缩放/移动/旋转内建的舞台——地面网格加上每个放置的图形（角色/机位）。
// 网格（editor.grid，由 Editor 拥有并由 Viewport.ts 作为独立通道渲染）不是
// `scene` 的子节点，因此必须与 scene.scale/position/rotation 一同显式驱动，
// 以与作为 scene 子节点的角色/机位保持同步。全景背景板故意游离于这一切之外——见下文。

const sceneScalePercent = ref(Math.round(scene.scale.x * 100) || 100)
const scenePositionX = ref(scene.position.x)
const scenePositionY = ref(scene.position.y)
const scenePositionZ = ref(scene.position.z)
const sceneRotationX = ref(scene.rotation.x * THREE.MathUtils.RAD2DEG)
const sceneRotationY = ref(scene.rotation.y * THREE.MathUtils.RAD2DEG)
const sceneRotationZ = ref(scene.rotation.z * THREE.MathUtils.RAD2DEG)

// 地面网格自身的高度偏移（见下方"地面"组）叠加在场景的 y 位置之上，
// 而非替换它，使缩放/移动舞台与微调地面高度互不冲突。
function applyGridPosition() {
  editor.grid.position.set(
    scenePositionX.value,
    scenePositionY.value + groundHeight.value,
    scenePositionZ.value
  )
}

watch(sceneScalePercent, (value) => {
  const scale = (Array.isArray(value) ? value[0] : value) / 100
  scene.scale.set(scale, scale, scale)
  editor.grid.scale.set(scale, scale, scale)
  requestRender()
})

watch([scenePositionX, scenePositionY, scenePositionZ], ([x, y, z]) => {
  scene.position.set(x, y, z)
  applyGridPosition()
  requestRender()
})

watch([sceneRotationX, sceneRotationY, sceneRotationZ], ([x, y, z]) => {
  scene.rotation.set(
    x * THREE.MathUtils.DEG2RAD,
    y * THREE.MathUtils.DEG2RAD,
    z * THREE.MathUtils.DEG2RAD
  )
  editor.grid.rotation.copy(scene.rotation)
  requestRender()
})

onMounted(() => {
  editor.grid.scale.copy(scene.scale)
  applyGridPosition()
  editor.grid.rotation.copy(scene.rotation)
})

// ----- 地面网格 -----
//
// showGround/groundOpacity 直接驱动 editor.grid/editor.groundPlane，
// 与上方场景变换的模式相同——此导演控制台不挂载 EditorMenubar，
// 因此没有其他地方争用 grid.visible。groundOpacity 仅影响地面平面网格的
// 填充材质；网格线辅助器（grid1/grid2，THREE.GridHelper/LineSegments）不受影响，
// 使线条保持完全不透明。

const showGround = ref(true)
const groundOpacity = ref(0.25)
const groundHeight = ref(0)

watch(showGround, (value) => {
  editor.grid.visible = value
  requestRender()
})

watch(groundOpacity, (value) => {
  const plane = editor.groundPlane
  plane.material.opacity = Array.isArray(value) ? value[0] : value
  plane.material.needsUpdate = true
  requestRender()
})

watch(groundHeight, () => {
  applyGridPosition()
  requestRender()
})

onMounted(() => {
  editor.grid.visible = showGround.value
  editor.groundPlane.material.opacity = groundOpacity.value
  editor.groundPlane.material.needsUpdate = true
})

// ----- 全景背景 -----
//
// 两个独立图层，故意不互相绑定：
//
// - 天空颜色是场景实际的背景填充——作为平面 THREE.Color 的 `scene.background`，
//   通过共享的 sceneBackgroundChanged 信号分发（与完整 three-editor
//   的"Color"背景类型机制相同）。平面颜色无朝向/深度，因此无需视差/缩放
//   处理——它始终存在于一切之后。
//
// - 全景纹理是 editor.backdrop 中一个真实的大型球体——既非原生的
//   `scene.background` 等距矩形纹理，也非 `scene` 的子节点。未加载纹理时
//   它不可见（sphere.visible = false），因此无选中对象时仅天空颜色
//   独自显示——无染色、无来自球体的回退填充。
//
//   Three.js 将等距矩形 scene.background 渲染在无限远处（其盒子网格每帧
//   重新对中相机，仅读取相机的*旋转*），因此它不会从相机平移中获得任何
//   视差：平移/缩放视口时它明显冻结而其他一切都在移动。真实网格则无此特例——
//   普通相机投影自动为其提供正确的视差/缩放，与网格一致。
//
//   它故意不是 `scene` 的子节点：全景代表固定的地平线，并非物理微缩舞台
//   的一部分，因此必须不受上方的场景缩放/平移/旋转控件影响（这些控件将
//   网格 + 角色/机位作为"舞台"进行缩放/移动）。editor.backdrop 是一个同级的
//   THREE.Scene，以相同相机在自身通道中渲染（Viewport.ts 的 render()），
//   因此它在保持正确视差/缩放的同时不受 `scene` 自身变换影响。
//
//   它在 `scene` 之后、`grid`/`sceneHelpers` 之前渲染（而非在 `scene` 之前：
//   scene.background 是平面 Color，Three.js 在渲染带 Color 背景的场景时无论
//   autoClear 如何都会强制清除缓冲区，因此先于 `scene` 绘制的任何内容都会
//   在 `scene` 渲染瞬间被擦除）。正是该顺序使地面平面的半透明填充
//   （editor.groundPlane，见下文）能对全景的真实像素进行混合：地面绘制时，
//   全景已存在于颜色缓冲区中，因此降低地面透明度会显露实际背景
//   而非平面颜色。将球体放在最后渲染（如 sceneHelpers 之前所做的）会导致
//   合成顺序颠倒——地面要么被球体完全覆盖，要么（一旦球体被深度遮挡）
//   只能与在它之前绘制的内容混合，永远无法与全景本身混合。将其作为独立场景
//   而非 sceneHelpers 子节点还使其免于点击拾取（Selector.ts 仅遍历 sceneHelpers），
//   也不出现在 DirectorScenePanel 的列表中（该列表仅读取 editor.scene.children）。
//
// scene.environment（环境光照/反射）是一个独立的、合理地与相机无关的概念，
// 因此仍由共享的 sceneEnvironmentChanged 信号驱动。

const panoramaTexture = ref<any>(null)
const skyColor = ref("#c2c2c2")
const horizontalRotation = ref(0)
// 地面网格/平面为固定的 30x30（Viewport.ts 的 GridHelper/PlaneGeometry），
// 其边长为 30。在 100% 场景缩放下，球体横截面直径应为该边长的两倍，
// 即 r = 30·2/2 = 30。
const panoramaRadius = ref(30)

let sphere: THREE.Mesh | null = null

function ensureSphere() {
  if (sphere) return sphere

  const material = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false
  })

  sphere = new THREE.Mesh(
    new THREE.SphereGeometry(panoramaRadius.value, 48, 32),
    material
  )
  sphere.name = "全景背景"
  sphere.renderOrder = -1
  sphere.visible = false

  editor.backdrop.add(sphere)
  return sphere
}

function applyBackgroundColor() {
  signals.sceneBackgroundChanged.dispatch(
    "Color",
    skyColor.value,
    null,
    null,
    THREE.NoColorSpace,
    0,
    1,
    0
  )
}

// 自动保存会恢复上一个会话的场景——包括 scene.background——
// 直接通过 Editor.setScene() 完成，完全绕过 sceneBackgroundChanged，
// 且为异步操作（IndexedDB，通过 ThreeEditor.vue 自身的 onMounted——
// 而作为父组件，它在*之后*触发，此时此组件的 onMounted 已推送了默认
// skyColor，因为子组件先于父组件挂载）。setScene() 完成后会分发
// sceneGraphChanged，因此此后立即将 scene.background 与 skyColor 对账：
// - 若恢复的背景是 Color，则将其纳入控件，使色板与实际渲染内容一致；
// - 否则（null，或来自旧自动保存/架构的陈旧非 Color 背景），此构建的
//   不变式是 scene.background 始终为由 skyColor 驱动的平面 Color，
//   因此重新断言当前值，而非让控件的显示与一个静默回退到渲染器默认
//   灰色清除色（Viewport.ts 的 `renderer.setClearColor(0xaaaaaa)`）的场景
//   保持脱节状态。
function syncSkyColorFromScene() {
  const background = scene.background as THREE.Color | null
  if (background && (background as any).isColor) {
    const hex = "#" + background.getHexString()
    if (hex !== skyColor.value) skyColor.value = hex
  } else {
    applyBackgroundColor()
  }
}

onMounted(() => signals.sceneGraphChanged.add(syncSkyColorFromScene))
onBeforeUnmount(() => signals.sceneGraphChanged.remove(syncSkyColorFromScene))

function applyEnvironmentLighting() {
  if (panoramaTexture.value) {
    signals.sceneEnvironmentChanged.dispatch(
      "Equirectangular",
      panoramaTexture.value
    )
  } else {
    signals.sceneEnvironmentChanged.dispatch("Default", null)
  }
}

watch(panoramaTexture, (texture) => {
  const mesh = ensureSphere()
  const material = mesh.material as THREE.MeshBasicMaterial
  material.map = texture ?? null
  material.needsUpdate = true
  mesh.visible = !!texture
  applyEnvironmentLighting()
  requestRender()
})

watch(skyColor, applyBackgroundColor)

watch(horizontalRotation, (value) => {
  const mesh = ensureSphere()
  mesh.rotation.y =
    (Array.isArray(value) ? value[0] : value) * THREE.MathUtils.DEG2RAD
  requestRender()
})

watch(panoramaRadius, (value) => {
  const mesh = ensureSphere()
  const radius = Array.isArray(value) ? value[0] : value
  mesh.geometry.dispose()
  mesh.geometry = new THREE.SphereGeometry(radius, 48, 32)
  requestRender()
})

onMounted(() => {
  ensureSphere()
  applyBackgroundColor()
})
</script>

<template>
  <ScrollArea v-show="!selected" class="h-full">
    <div class="flex flex-col gap-4 p-3">
      <div class="text-xs font-medium text-muted-foreground">3D场景</div>

      <div class="space-y-2">
        <Label class="text-xs">场景缩放</Label>
        <div class="flex items-center gap-2">
          <Slider
            :model-value="[sceneScalePercent]"
            :min="10"
            :max="500"
            :step="1"
            @update:model-value="
              (v) => (sceneScalePercent = v?.[0] ?? sceneScalePercent)
            "
          />
          <span class="w-12 shrink-0 text-right text-xs text-muted-foreground">
            {{ sceneScalePercent }}%
          </span>
        </div>
      </div>

      <div class="space-y-2">
        <Label class="text-xs">场景平移</Label>
        <div class="grid grid-cols-3 gap-2">
          <NumberField v-model="scenePositionX" :step="0.1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField v-model="scenePositionY" :step="0.1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField v-model="scenePositionZ" :step="0.1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
        </div>
      </div>

      <div class="space-y-2">
        <Label class="text-xs">场景旋转</Label>
        <div class="grid grid-cols-3 gap-2">
          <NumberField v-model="sceneRotationX" :step="1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField v-model="sceneRotationY" :step="1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField v-model="sceneRotationZ" :step="1">
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
        </div>
      </div>

      <Separator />

      <div class="space-y-2">
        <Label class="text-xs">全景背景</Label>
        <div class="flex items-center gap-2">
          <TextureField v-model="panoramaTexture" :editor="editor" />
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {{ panoramaTexture?.sourceFile || "未连接全景图" }}
          </span>
        </div>
      </div>

      <div class="space-y-2">
        <Label class="text-xs">天空颜色</Label>
        <div class="flex items-center gap-2">
          <input
            v-model="skyColor"
            type="color"
            class="h-8 w-10 rounded-md border border-input"
          />
          <input
            v-model="skyColor"
            type="text"
            class="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
          />
        </div>
      </div>

      <Separator />

      <div class="space-y-1">
        <div
          class="flex items-center justify-between text-xs text-muted-foreground"
        >
          <span>全景水平旋转</span>
          <span>{{ horizontalRotation }}°</span>
        </div>
        <Slider
          :model-value="[horizontalRotation]"
          :min="0"
          :max="360"
          :step="1"
          @update:model-value="
            (v) => (horizontalRotation = v?.[0] ?? horizontalRotation)
          "
        />
      </div>

      <div class="space-y-1">
        <div
          class="flex items-center justify-between text-xs text-muted-foreground"
        >
          <span>全景球半径</span>
          <span>{{ panoramaRadius }}</span>
        </div>
        <Slider
          :model-value="[panoramaRadius]"
          :min="20"
          :max="500"
          :step="10"
          @update:model-value="
            (v) => (panoramaRadius = v?.[0] ?? panoramaRadius)
          "
        />
      </div>

      <Separator />

      <div class="flex items-center justify-between">
        <Label class="text-xs">角色标签</Label>
        <Switch v-model="showCharacterLabels" />
      </div>

      <Separator />

      <div class="text-xs font-medium text-muted-foreground">地面</div>

      <div class="flex items-center justify-between">
        <Label class="text-xs">显示地面</Label>
        <Switch v-model="showGround" />
      </div>

      <div class="space-y-1">
        <div
          class="flex items-center justify-between text-xs text-muted-foreground"
        >
          <span>透明度</span>
          <span>{{ groundOpacity.toFixed(2) }}</span>
        </div>
        <Slider
          :model-value="[groundOpacity]"
          :min="0"
          :max="1"
          :step="0.01"
          @update:model-value="(v) => (groundOpacity = v?.[0] ?? groundOpacity)"
        />
      </div>

      <div class="space-y-1">
        <div
          class="flex items-center justify-between text-xs text-muted-foreground"
        >
          <span>高度</span>
          <span>{{ groundHeight.toFixed(1) }}</span>
        </div>
        <Slider
          :model-value="[groundHeight]"
          :min="-2"
          :max="2"
          :step="0.1"
          @update:model-value="(v) => (groundHeight = v?.[0] ?? groundHeight)"
        />
      </div>
    </div>
  </ScrollArea>
</template>
