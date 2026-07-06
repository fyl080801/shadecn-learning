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

// Shown only while nothing is selected — stays mounted (v-show, not v-if)
// so background watchers keep running when the user selects a graphic and
// this panel hides in favor of the object panel.
const selected = ref<any>(editor.selected)
function onObjectSelected(object: any) {
  selected.value = object
}
onMounted(() => signals.objectSelected.add(onObjectSelected))
onBeforeUnmount(() => signals.objectSelected.remove(onObjectSelected))

// ----- scene transform -----
//
// Scales/moves/rotates the built stage — the ground grid plus every placed
// graphic (characters/机位). The grid (editor.grid, owned by Editor and
// rendered as its own pass by Viewport.ts) is not a child of `scene`, so it
// has to be driven explicitly alongside scene.scale/position/rotation to
// stay in lockstep with the characters/机位 that *are* scene children. The
// panorama backdrop deliberately sits outside all of this — see below.

const sceneScalePercent = ref(Math.round(scene.scale.x * 100) || 100)
const scenePositionX = ref(scene.position.x)
const scenePositionY = ref(scene.position.y)
const scenePositionZ = ref(scene.position.z)
const sceneRotationX = ref(scene.rotation.x * THREE.MathUtils.RAD2DEG)
const sceneRotationY = ref(scene.rotation.y * THREE.MathUtils.RAD2DEG)
const sceneRotationZ = ref(scene.rotation.z * THREE.MathUtils.RAD2DEG)

// The ground grid's own height offset (see "地面" group below) is added on
// top of the scene's y position rather than replacing it, so scaling/moving
// the stage and nudging the ground plane's height don't fight each other.
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

// ----- ground grid -----
//
// showGround/groundOpacity drive editor.grid/editor.groundPlane directly,
// the same pattern the scene transform above uses — this director console
// never mounts EditorMenubar, so nothing else contends for grid.visible.
// groundOpacity only touches the ground plane mesh's fill material; the
// grid line helpers (grid1/grid2, THREE.GridHelper/LineSegments) are
// untouched so the lines stay fully opaque.

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

// ----- panorama background -----
//
// Two independent layers, deliberately not tied to each other:
//
// - 天空颜色 is the scene's actual background fill — `scene.background` as a
//   flat THREE.Color, via the shared sceneBackgroundChanged signal (same
//   mechanism the full three-editor uses for its "Color" background type).
//   A flat color has no orientation/depth, so it needs no parallax/zoom
//   handling — it's just always there, behind everything.
//
// - The panorama texture is a real, large sphere in editor.backdrop — not a
//   native `scene.background` Equirectangular texture, and not a child of
//   `scene` either. It's invisible (sphere.visible = false) whenever no
//   texture is loaded, so with nothing selected 天空颜色 alone shows through
//   untouched — no tinting, no fallback fill from the sphere.
//
//   Three.js renders an Equirectangular scene.background at infinite
//   distance (its box mesh recenters on the camera every frame and only
//   reads camera *rotation*), so it never gets any parallax from camera
//   translation: panning/zooming the viewport left it visibly frozen while
//   everything else moved. A real mesh has no such special case — ordinary
//   camera projection gives it correct parallax/zoom automatically, same as
//   the grid.
//
//   It's deliberately NOT a child of `scene`: the panorama represents a
//   fixed horizon, not part of the physical miniature stage, so it must
//   stay unaffected by the 场景缩放/平移/旋转 controls above (which scale/move
//   the grid + characters/机位 as "the stage"). editor.backdrop is a sibling
//   THREE.Scene rendered in its own pass with the same camera (Viewport.ts's
//   render()), so it keeps correct parallax/zoom while staying immune to
//   `scene`'s own transform.
//
//   It's rendered right after `scene` but before `grid`/`sceneHelpers` (not
//   before `scene`: scene.background is a flat Color, and Three.js
//   force-clears the buffer whenever it renders a scene with a Color
//   background regardless of autoClear, so anything drawn earlier than
//   `scene` gets wiped the instant `scene` renders). That order is what
//   makes the ground plane's translucent fill (editor.groundPlane, see
//   below) blend against the panorama's real pixels: by the time the
//   ground draws, the panorama is already sitting in the color buffer, so
//   lowering 地面透明度 reveals the actual backdrop instead of a flat color.
//   Rendering the sphere last (as sceneHelpers previously did) got the
//   composite backwards — the ground either got painted over by the sphere
//   entirely, or (once the sphere was depth-blocked) could only ever blend
//   against whatever was drawn before it, never the panorama itself. Being
//   its own scene rather than a sceneHelpers child also keeps it out of
//   click-picking (Selector.ts only traverses sceneHelpers) and out of
//   DirectorScenePanel's list, which only reads editor.scene.children.
//
// scene.environment (ambient lighting/reflections) is a separate, legitimately
// camera-independent concept, so it's still driven by the shared
// sceneEnvironmentChanged signal.

const panoramaTexture = ref<any>(null)
const skyColor = ref("#060608")
const horizontalRotation = ref(0)
// Ground grid/plane is a fixed 30x30 (Viewport.ts's GridHelper/PlaneGeometry),
// so its footprint area is 900. At 100% 场景缩放 the sphere's great-circle
// cross-section (π·r²) should be twice that, i.e. r = sqrt(2·900 / π) ≈ 23.9.
const panoramaRadius = ref(24)

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

// Autosave restores a previous session's scene — including scene.background
// — directly via Editor.setScene(), bypassing sceneBackgroundChanged
// entirely, and asynchronously (IndexedDB, via ThreeEditor.vue's own
// onMounted — which, being the parent, fires *after* this component's
// onMounted already pushed the default skyColor, since children mount
// before their parent). setScene() dispatches sceneGraphChanged once it's
// done, so this reconciles scene.background against skyColor right after:
// - if the restored background is a Color, adopt it into the control so
//   the swatch matches what's actually rendered;
// - otherwise (null, or a stale non-Color background from an older
//   autosave/architecture) this build's invariant is that scene.background
//   is always a flat Color driven by skyColor, so reassert the current
//   value instead of leaving the control's display stuck out of sync with
//   a scene that silently fell back to the renderer's default gray clear
//   color (Viewport.ts's `renderer.setClearColor(0xaaaaaa)`).
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
