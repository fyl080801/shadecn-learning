<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch
} from "vue"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { SetPositionCommand } from "@/components/three-editor/commands/SetPositionCommand"
import { SetRotationCommand } from "@/components/three-editor/commands/SetRotationCommand"
import { SetScaleCommand } from "@/components/three-editor/commands/SetScaleCommand"
import { SetValueCommand } from "@/components/three-editor/commands/SetValueCommand"
import { SetMaterialColorCommand } from "@/components/three-editor/commands/SetMaterialColorCommand"
import { MultiCmdsCommand } from "@/components/three-editor/commands/MultiCmdsCommand"
import {
  isCharacterObject,
  ensureSkeletonLines,
  removeSkeletonLines,
  removeStockSkeletonHelpers
} from "./characterPose"
import DirectorCharacterPosePanel from "./DirectorCharacterPosePanel.vue"

const editor = useEditor()
const signals = editor.signals

// 普通 `ref()` 会将 THREE.Object3D 深度包装为响应式代理，因此
// 由 `selected.value` 构建的命令与存储在 `editor.selected` 上的原始对象
// 身份不同——比较 `editor.selected === object` 的信号处理器
// （如视口的选中框更新器）随后会静默无操作。`shallowRef` 使对象保持未代理状态。
const selected = shallowRef<any>(editor.selected)

const name = ref("")
const positionX = ref(0)
const positionY = ref(0)
const positionZ = ref(0)
const rotationX = ref(0)
const rotationY = ref(0)
const rotationZ = ref(0)
const scaleX = ref(1)
const scaleY = ref(1)
const scaleZ = ref(1)
const uniformScale = ref(1)
const color = ref("#9aa5b1")
const visible = ref(true)

// 摄像机由专门的 DirectorCameraPropertiesPanel 处理，此面板对其隐藏。
const isMesh = computed(() => !!selected.value?.isMesh)
const isCharacter = computed(() => isCharacterObject(selected.value))
const activeTab = ref<"properties" | "pose">("properties")

// 骨架线叠加层不再由手动开关持久化，而是随"姿势"选项卡的显隐联动。
// Viewport 采用按需渲染（仅在特定信号触发时重绘，而非每帧渲染），因此单纯
// 修改 line.visible 不会立即反映到画布上——必须显式分发一个会触发 render()
// 的信号。这里用 objectChanged 而非 sceneGraphChanged：后者被
// useCharacterSkeletonOverlay 的场景扫描监听，扫描会无条件把所有角色的骨架线
// 隐藏，若在此仍用 sceneGraphChanged 会与刚设置的可见性互相打架。
watch(activeTab, (tab) => {
  const object = selected.value
  if (object && isCharacterObject(object)) {
    ensureSkeletonLines(editor, object).visible = tab === "pose"
    signals.objectChanged.dispatch(object)
  }
})

// 该面板编辑两个独立量，二者都汇入同一个 THREE.Object3D.scale：
// 逐轴的 `scaleX/Y/Z` 字段（网格的"基础"尺寸）和 `uniformScale`
// （在基础尺寸之上的整体倍数，例如用于快速调整角色大小而不丢失其创作的比例）。
// 二者本身都不是对象的实际缩放值，因此都暂存于 userData 上
// （一种非撤销追踪的约定），由面板将它们映射到 object.scale：
// scale = base * uniformScale。
function ensureScaleState(object: any) {
  if (!object.userData.scaleBase) {
    object.userData.scaleBase = {
      x: object.scale.x,
      y: object.scale.y,
      z: object.scale.z
    }
  }
  if (typeof object.userData.uniformScale !== "number") {
    object.userData.uniformScale = 1
  }
  return object.userData as {
    scaleBase: { x: number; y: number; z: number }
    uniformScale: number
  }
}

function applyScale(
  object: any,
  base: { x: number; y: number; z: number },
  factor: number
) {
  const newScale = new THREE.Vector3(
    base.x * factor,
    base.y * factor,
    base.z * factor
  )
  if (object.scale.distanceTo(newScale) >= 0.001) {
    editor.execute(new SetScaleCommand(editor, object, newScale))
  }
}

function syncFromObject(object: any) {
  name.value = object.name
  positionX.value = object.position.x
  positionY.value = object.position.y
  positionZ.value = object.position.z
  rotationX.value = object.rotation.x * THREE.MathUtils.RAD2DEG
  rotationY.value = object.rotation.y * THREE.MathUtils.RAD2DEG
  rotationZ.value = object.rotation.z * THREE.MathUtils.RAD2DEG

  const { scaleBase, uniformScale: factor } = ensureScaleState(object)
  scaleX.value = scaleBase.x
  scaleY.value = scaleBase.y
  scaleZ.value = scaleBase.z
  uniformScale.value = factor

  visible.value = object.visible

  if (object.isMesh && object.material && !Array.isArray(object.material)) {
    color.value = "#" + object.material.color.getHexString()
  } else if (isCharacterObject(object)) {
    // 颜色选择器应显示主体颜色而非（略深的）关节球颜色，因此优先取
    // 非 "Joints" 网格的材质颜色作为当前色。
    const meshes = characterMeshes(object)
    const body =
      meshes.find((mesh) => !isJointMesh(mesh)) ?? meshes[0]
    if (body) color.value = "#" + body.material.color.getHexString()

    removeStockSkeletonHelpers(editor, object)
    ensureSkeletonLines(editor, object).visible = activeTab.value === "pose"
  }
}

function onObjectSelected(object: any) {
  // 取消选择或切换到其它对象时，先前被选中角色的骨架叠加层不会随
  // activeTab 的 watch 联动隐藏——因为 selected.value 在 watch 触发前
  // 已被置空，watch 中的 isCharacterObject(object) 判定为假而不执行。
  // 因此在切换前显式隐藏旧角色的骨架线，保证骨架仅在"角色被选中且
  // 面板处于姿势选项卡"时才可见。
  const previous = selected.value
  if (previous && previous !== object && isCharacterObject(previous)) {
    ensureSkeletonLines(editor, previous).visible = false
    signals.objectChanged.dispatch(previous)
  }
  selected.value = object
  activeTab.value = "properties"
  if (object) syncFromObject(object)
}

function onObjectChanged(object: any) {
  if (object === editor.selected) syncFromObject(object)
}

function onMaterialChanged(object: any) {
  if (object === editor.selected) syncFromObject(object)
}

// ensureSkeletonLines 的叠加层位于 editor.sceneHelpers 中，独立于
// 其所构建的角色，因此在删除角色时不会自动清理——需在此显式清除。
function onObjectRemoved(object: any) {
  if (isCharacterObject(object)) removeSkeletonLines(editor, object)
}

function onEditorCleared() {
  for (const child of [...editor.sceneHelpers.children]) {
    if (child.name.startsWith("__skeletonLines__")) {
      editor.sceneHelpers.remove(child)
      child.geometry.dispose()
      child.material.dispose()
    }
  }
}

onMounted(() => {
  if (selected.value) syncFromObject(selected.value)
  signals.objectSelected.add(onObjectSelected)
  signals.objectChanged.add(onObjectChanged)
  signals.materialChanged.add(onMaterialChanged)
  signals.objectRemoved.add(onObjectRemoved)
  signals.editorCleared.add(onEditorCleared)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.objectChanged.remove(onObjectChanged)
  signals.materialChanged.remove(onMaterialChanged)
  signals.objectRemoved.remove(onObjectRemoved)
  signals.editorCleared.remove(onEditorCleared)
})

function commitName() {
  const object = selected.value
  if (!object || object.name === name.value) return
  editor.execute(new SetValueCommand(editor, object, "name", name.value))
}

function commitTransform() {
  const object = selected.value
  if (!object) return

  const newPosition = new THREE.Vector3(
    positionX.value,
    positionY.value,
    positionZ.value
  )
  if (object.position.distanceTo(newPosition) >= 0.001) {
    editor.execute(new SetPositionCommand(editor, object, newPosition))
  }

  const newRotation = new THREE.Euler(
    rotationX.value * THREE.MathUtils.DEG2RAD,
    rotationY.value * THREE.MathUtils.DEG2RAD,
    rotationZ.value * THREE.MathUtils.DEG2RAD
  )
  if (
    new THREE.Vector3()
      .setFromEuler(object.rotation)
      .distanceTo(new THREE.Vector3().setFromEuler(newRotation)) >= 0.001
  ) {
    editor.execute(new SetRotationCommand(editor, object, newRotation))
  }

  const { uniformScale: factor } = ensureScaleState(object)
  const scaleBase = { x: scaleX.value, y: scaleY.value, z: scaleZ.value }
  object.userData.scaleBase = scaleBase
  applyScale(object, scaleBase, factor)
}

function commitUniformScale(value: number) {
  const object = selected.value
  if (!object) return

  const { scaleBase } = ensureScaleState(object)
  object.userData.uniformScale = value
  uniformScale.value = value
  applyScale(object, scaleBase, value)
}

function characterMeshes(object: any): any[] {
  const meshes: any[] = []
  object.traverse((child: any) => {
    if (child.isMesh && child.material && !Array.isArray(child.material)) {
      meshes.push(child)
    }
  })
  return meshes
}

// Mixamo 素体（Y Bot / X Bot）由两个蒙皮网格组成：以 "Surface" 结尾的主体
// 网格，与以 "Joints" 结尾的关节球网格（每个关节处的小球）。编辑颜色时，
// 关节球应使用比主体略深的同色调，以便与主体区分。对于不遵循该命名的
// 导入角色，没有关节球网格，所有网格统一使用主体颜色（行为不变）。
const JOINT_MESH_SUFFIX = /Joints$/i

// 关节球相对主体的变暗系数：将 RGB 各分量乘以该系数，得到同色相但略深的色调。
const JOINT_COLOR_DARKEN = 0.65

function isJointMesh(mesh: any): boolean {
  return JOINT_MESH_SUFFIX.test(mesh.name ?? "")
}

function darkenHex(hex: number, factor: number): number {
  const color = new THREE.Color(hex)
  color.multiplyScalar(factor)
  return color.getHex()
}

// removeStockSkeletonHelpers/ensureSkeletonLines/removeSkeletonLines/
// skeletonLineName live in characterPose.ts so useCharacterSkeletonOverlay.ts
// (the scene-wide sweep on restore) can share them.

function commitColor() {
  const object = selected.value
  if (!object) return

  const hex = parseInt(color.value.replace("#", ""), 16)

  if (object.isMesh && object.material && !Array.isArray(object.material)) {
    if (object.material.color.getHex() !== hex) {
      editor.execute(new SetMaterialColorCommand(editor, object, "color", hex))
    }
    return
  }

  if (isCharacterObject(object)) {
    const jointHex = darkenHex(hex, JOINT_COLOR_DARKEN)
    const cmds = characterMeshes(object)
      .filter((mesh) => {
        const target = isJointMesh(mesh) ? jointHex : hex
        return mesh.material.color.getHex() !== target
      })
      .map((mesh) => {
        const target = isJointMesh(mesh) ? jointHex : hex
        return new SetMaterialColorCommand(editor, mesh, "color", target)
      })
    if (cmds.length) editor.execute(new MultiCmdsCommand(editor, cmds))
  }
}

function toggleVisible(value: boolean) {
  const object = selected.value
  if (!object) return
  editor.execute(new SetValueCommand(editor, object, "visible", value))
}
</script>

<template>
  <ScrollArea v-show="selected && !selected.isCamera" class="h-full">
    <div v-if="selected && !selected.isCamera" class="flex flex-col gap-4 p-3">
      <template v-if="isCharacter">
        <div class="text-xs font-medium text-muted-foreground">角色</div>
        <Tabs v-model="activeTab">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="properties">属性</TabsTrigger>
            <TabsTrigger value="pose">姿势</TabsTrigger>
          </TabsList>
        </Tabs>
      </template>
      <div v-else class="text-xs font-medium text-muted-foreground">
        图形属性
      </div>

      <DirectorCharacterPosePanel
        v-if="isCharacter && activeTab === 'pose'"
        :character="selected"
      />

      <template v-if="!isCharacter || activeTab === 'properties'">
        <div class="space-y-2">
          <Label class="text-xs">名称</Label>
          <input
            v-model="name"
            type="text"
            class="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            @change="commitName"
          />
        </div>

        <div class="space-y-2">
          <Label class="text-xs">位置</Label>
          <div class="grid grid-cols-3 gap-2">
            <NumberField
              v-model="positionX"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="positionY"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="positionZ"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>
        </div>

        <div class="space-y-2">
          <Label class="text-xs">旋转</Label>
          <div class="grid grid-cols-3 gap-2">
            <NumberField
              v-model="rotationX"
              :step="1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="rotationY"
              :step="1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="rotationZ"
              :step="1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>
        </div>

        <div class="space-y-2">
          <Label class="text-xs">缩放</Label>
          <div class="grid grid-cols-3 gap-2">
            <NumberField
              v-model="scaleX"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="scaleY"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="scaleZ"
              :step="0.1"
              @update:model-value="commitTransform"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>

          <div
            class="flex items-center justify-between text-[10px] text-muted-foreground"
          >
            <span>统一缩放</span>
            <span>{{ uniformScale.toFixed(1) }}</span>
          </div>
          <Slider
            :model-value="[uniformScale]"
            :min="0.1"
            :max="10"
            :step="0.1"
            @update:model-value="
              (v) => commitUniformScale(v?.[0] ?? uniformScale)
            "
          />

          <div v-if="isMesh || isCharacter" class="flex items-center gap-2">
            <input
              v-model="color"
              type="color"
              class="h-8 w-10 rounded-md border border-input"
              @change="commitColor"
            />
            <input
              v-model="color"
              type="text"
              class="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
              @change="commitColor"
            />
          </div>
        </div>

        <Separator />

        <div class="flex items-center justify-between">
          <Label class="text-xs">可见性</Label>
          <Switch :model-value="visible" @update:model-value="toggleVisible" />
        </div>
      </template>
    </div>
  </ScrollArea>
</template>
