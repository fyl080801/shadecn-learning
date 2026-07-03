<script setup lang="ts">
// @ts-nocheck
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue"
import * as THREE from "three"
import { ChevronDown, ChevronRight } from "lucide-vue-next"

import { useEditor } from "./composables/useEditorContext"
import TextureField from "./TextureField.vue"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput
} from "@/components/ui/number-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const NO_COLOR_SPACE = "__none__"

// ----- outliner -----

const expanded = reactive(new Map<string, boolean>())
const selectedId = ref<number | null>(null)
const graphVersion = ref(0)

function objectType(object: any) {
  if (object.isScene) return "Scene"
  if (object.isCamera) return "Camera"
  if (object.isLight) return "Light"
  if (object.isMesh) return "Mesh"
  if (object.isLine) return "Line"
  if (object.isPoints) return "Points"
  return "Object3D"
}

function materialName(material: any) {
  if (Array.isArray(material)) return material.map((m) => m.name).join(", ")
  return material.name
}

function hasScript(uuid: string) {
  return editor.scripts[uuid] !== undefined && editor.scripts[uuid].length > 0
}

const flatNodes = computed(() => {
  graphVersion.value

  const nodes: Array<{ object: any; depth: number; hasChildren: boolean }> = []
  nodes.push({ object: editor.camera, depth: 0, hasChildren: false })

  const sceneHasChildren = editor.scene.children.length > 0
  nodes.push({ object: editor.scene, depth: 0, hasChildren: sceneHasChildren })

  function walk(objects: any[], depth: number) {
    for (const object of objects) {
      const hasChildren = object.children.length > 0
      nodes.push({ object, depth, hasChildren })
      if (hasChildren && expanded.get(object.uuid)) {
        walk(object.children, depth + 1)
      }
    }
  }

  if (sceneHasChildren && expanded.get(editor.scene.uuid)) {
    walk(editor.scene.children, 1)
  }

  return nodes
})

function ensureDefaultExpanded() {
  if (!expanded.has(editor.scene.uuid)) {
    expanded.set(editor.scene.uuid, true)
  }
}

function toggleExpanded(object: any) {
  expanded.set(object.uuid, !expanded.get(object.uuid))
  graphVersion.value++
}

let ignoreObjectSelectedSignal = false

function selectRow(object: any) {
  ignoreObjectSelectedSignal = true
  editor.selectById(object.id)
  ignoreObjectSelectedSignal = false
  selectedId.value = object.id
}

function focusRow(object: any) {
  editor.focusById(object.id)
}

// ----- background -----

const backgroundTypeOptions = ["Default", "Color", "Texture", "Equirectangular"]
const backgroundType = ref("Default")
const backgroundColor = ref("#000000")
const backgroundColorSpace = ref(NO_COLOR_SPACE)
const backgroundBlurriness = ref(0)
const backgroundIntensity = ref(1)
const backgroundRotation = ref(0)

const colorSpaceOptions = [
  { value: NO_COLOR_SPACE, label: "No Color Space" },
  { value: THREE.LinearSRGBColorSpace, label: "srgb-linear" },
  { value: THREE.SRGBColorSpace, label: "srgb" }
]

function resolveColorSpace(value: string) {
  return value === NO_COLOR_SPACE ? THREE.NoColorSpace : value
}

const sceneTextures = reactive<{
  background: any
  backgroundEquirect: any
  environmentEquirect: any
}>({ background: null, backgroundEquirect: null, environmentEquirect: null })

function onBackgroundChanged() {
  signals.sceneBackgroundChanged.dispatch(
    backgroundType.value,
    backgroundColor.value.replace("#", "0x"),
    sceneTextures.background,
    sceneTextures.backgroundEquirect,
    resolveColorSpace(backgroundColorSpace.value),
    backgroundBlurriness.value,
    backgroundIntensity.value,
    backgroundRotation.value
  )
}

function onBackgroundTypeChange() {
  onBackgroundChanged()
}

// ----- environment -----

const environmentTypeOptions = ["Default", "Equirectangular", "None"]
const environmentType = ref("Default")

function onEnvironmentChanged() {
  signals.sceneEnvironmentChanged.dispatch(
    environmentType.value,
    sceneTextures.environmentEquirect
  )
}

// ----- fog -----

const fogTypeOptions = [
  { value: "None", label: "None" },
  { value: "Fog", label: "Linear" },
  { value: "FogExp2", label: "Exponential" }
]
const fogType = ref("None")
const fogColor = ref("#aaaaaa")
const fogNear = ref(0.1)
const fogFar = ref(50)
const fogDensity = ref(0.05)

function onFogChanged() {
  signals.sceneFogChanged.dispatch(
    fogType.value,
    fogColor.value.replace("#", "0x"),
    fogNear.value,
    fogFar.value,
    fogDensity.value
  )
}

function onFogSettingsChanged() {
  signals.sceneFogSettingsChanged.dispatch(
    fogType.value,
    fogColor.value.replace("#", "0x"),
    fogNear.value,
    fogFar.value,
    fogDensity.value
  )
}

// ----- sync from editor state -----

function refreshUI() {
  ensureDefaultExpanded()
  graphVersion.value++

  const scene = editor.scene

  backgroundType.value = editor.backgroundType

  switch (editor.backgroundType) {
    case "Color":
      backgroundColor.value = "#" + scene.background.getHexString()
      break

    case "Texture":
      sceneTextures.background = scene.background
      backgroundColorSpace.value =
        scene.background.colorSpace === THREE.NoColorSpace
          ? NO_COLOR_SPACE
          : scene.background.colorSpace
      break

    case "Equirectangular":
      sceneTextures.backgroundEquirect = scene.background
      backgroundBlurriness.value = scene.backgroundBlurriness
      backgroundIntensity.value = scene.backgroundIntensity
      backgroundColorSpace.value =
        scene.background.colorSpace === THREE.NoColorSpace
          ? NO_COLOR_SPACE
          : scene.background.colorSpace
      break

    default:
      sceneTextures.background = null
      sceneTextures.backgroundEquirect = null
      backgroundColorSpace.value = NO_COLOR_SPACE
  }

  environmentType.value = editor.environmentType

  sceneTextures.environmentEquirect =
    editor.environmentType === "Equirectangular" ? scene.environment : null

  if (scene.fog) {
    fogColor.value = "#" + scene.fog.color.getHexString()

    if (scene.fog.isFog) {
      fogType.value = "Fog"
      fogNear.value = scene.fog.near
      fogFar.value = scene.fog.far
    } else if (scene.fog.isFogExp2) {
      fogType.value = "FogExp2"
      fogDensity.value = scene.fog.density
    }
  } else {
    fogType.value = "None"
  }

  if (editor.selected !== null) {
    selectedId.value = editor.selected.id
  }
}

function onObjectSelected(object: any) {
  if (ignoreObjectSelectedSignal === true) return

  if (object !== null && object.parent !== null) {
    let needsRefresh = false
    let parent = object.parent

    while (parent !== null) {
      if (expanded.get(parent.uuid) !== true) {
        expanded.set(parent.uuid, true)
        needsRefresh = true
      }
      if (parent === editor.scene) break
      parent = parent.parent
    }

    if (needsRefresh) graphVersion.value++

    selectedId.value = object.id
  } else {
    selectedId.value = null
  }
}

function onSceneBackgroundChanged() {
  if (environmentType.value === "Background") {
    onEnvironmentChanged()
  }
}

onMounted(() => {
  refreshUI()

  signals.editorCleared.add(refreshUI)
  signals.sceneGraphChanged.add(refreshUI)
  signals.cameraResetted.add(refreshUI)
  signals.objectSelected.add(onObjectSelected)
  signals.sceneBackgroundChanged.add(onSceneBackgroundChanged)
})

onBeforeUnmount(() => {
  signals.editorCleared.remove(refreshUI)
  signals.sceneGraphChanged.remove(refreshUI)
  signals.cameraResetted.remove(refreshUI)
  signals.objectSelected.remove(onObjectSelected)
  signals.sceneBackgroundChanged.remove(onSceneBackgroundChanged)
})
</script>

<template>
  <div class="te-sidebar-scene flex h-full flex-col">
    <ScrollArea class="h-48 shrink-0 border-b">
      <div class="p-1">
        <button
          v-for="node in flatNodes"
          :key="node.object.uuid ?? node.object.id"
          type="button"
          class="hover:bg-accent flex w-full items-center gap-1 rounded-sm px-1 py-1 text-left text-xs"
          :class="{ 'bg-accent': selectedId === node.object.id }"
          :style="{ paddingLeft: node.depth * 14 + 4 + 'px' }"
          @click="selectRow(node.object)"
          @dblclick="focusRow(node.object)"
        >
          <span
            class="flex size-4 shrink-0 items-center justify-center"
            @click.stop="node.hasChildren && toggleExpanded(node.object)"
          >
            <component
              :is="expanded.get(node.object.uuid) ? ChevronDown : ChevronRight"
              v-if="node.hasChildren"
              class="size-3"
            />
          </span>
          <Badge variant="outline" class="px-1 py-0 text-[10px]">
            {{ objectType(node.object) }}
          </Badge>
          <span class="truncate">{{ node.object.name }}</span>
          <Badge
            v-if="node.object.isMesh"
            variant="secondary"
            class="px-1 py-0 text-[10px]"
          >
            {{ node.object.geometry.name || objectType(node.object) }}
          </Badge>
          <Badge
            v-if="node.object.isMesh"
            variant="secondary"
            class="px-1 py-0 text-[10px]"
          >
            {{ materialName(node.object.material) || "Material" }}
          </Badge>
          <Badge
            v-if="hasScript(node.object.uuid)"
            variant="secondary"
            class="px-1 py-0 text-[10px]"
          >
            Script
          </Badge>
        </button>
      </div>
    </ScrollArea>

    <ScrollArea class="flex-1">
      <div class="space-y-4 p-3">
        <!-- background -->
        <div class="space-y-2">
          <Label class="text-xs">{{ t("sidebar/scene/background") }}</Label>
          <div class="flex items-center gap-2">
            <Select
              v-model="backgroundType"
              @update:model-value="onBackgroundTypeChange"
            >
              <SelectTrigger size="sm" class="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in backgroundTypeOptions"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </SelectItem>
              </SelectContent>
            </Select>

            <input
              v-if="backgroundType === 'Color'"
              v-model="backgroundColor"
              type="color"
              class="border-input h-8 w-10 rounded-md border"
              @input="onBackgroundChanged"
            />

            <TextureField
              v-show="backgroundType === 'Texture'"
              v-model="sceneTextures.background"
              :editor="editor"
              @update:model-value="onBackgroundChanged"
            />
            <TextureField
              v-show="backgroundType === 'Equirectangular'"
              v-model="sceneTextures.backgroundEquirect"
              :editor="editor"
              @update:model-value="onBackgroundChanged"
            />
          </div>

          <div
            v-if="
              backgroundType === 'Texture' ||
              backgroundType === 'Equirectangular'
            "
            class="ml-2 flex items-center gap-2"
          >
            <Select
              v-model="backgroundColorSpace"
              @update:model-value="onBackgroundChanged"
            >
              <SelectTrigger size="sm" class="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in colorSpaceOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div
            v-if="backgroundType === 'Equirectangular'"
            class="ml-2 grid grid-cols-3 gap-2"
          >
            <NumberField
              v-model="backgroundBlurriness"
              :min="0"
              :max="1"
              :step="0.01"
              @update:model-value="onBackgroundChanged"
            >
              <NumberFieldContent>
                <NumberFieldDecrement />
                <NumberFieldInput class="h-7 text-xs" />
                <NumberFieldIncrement />
              </NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="backgroundIntensity"
              :min="0"
              :step="0.1"
              @update:model-value="onBackgroundChanged"
            >
              <NumberFieldContent>
                <NumberFieldDecrement />
                <NumberFieldInput class="h-7 text-xs" />
                <NumberFieldIncrement />
              </NumberFieldContent>
            </NumberField>
            <NumberField
              v-model="backgroundRotation"
              :min="-180"
              :max="180"
              :step="10"
              @update:model-value="onBackgroundChanged"
            >
              <NumberFieldContent>
                <NumberFieldDecrement />
                <NumberFieldInput class="h-7 text-xs" />
                <NumberFieldIncrement />
              </NumberFieldContent>
            </NumberField>
          </div>
        </div>

        <!-- environment -->
        <div class="space-y-2">
          <Label class="text-xs">{{ t("sidebar/scene/environment") }}</Label>
          <div class="flex items-center gap-2">
            <Select
              v-model="environmentType"
              @update:model-value="onEnvironmentChanged"
            >
              <SelectTrigger size="sm" class="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in environmentTypeOptions"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </SelectItem>
              </SelectContent>
            </Select>

            <TextureField
              v-show="environmentType === 'Equirectangular'"
              v-model="sceneTextures.environmentEquirect"
              :editor="editor"
              @update:model-value="onEnvironmentChanged"
            />
          </div>
        </div>

        <!-- fog -->
        <div class="space-y-2">
          <Label class="text-xs">{{ t("sidebar/scene/fog") }}</Label>
          <Select v-model="fogType" @update:model-value="onFogChanged">
            <SelectTrigger size="sm" class="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="option in fogTypeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>

          <div v-if="fogType !== 'None'" class="ml-2 flex items-center gap-2">
            <input
              v-model="fogColor"
              type="color"
              class="border-input h-8 w-10 rounded-md border"
              @input="onFogSettingsChanged"
            />

            <template v-if="fogType === 'Fog'">
              <NumberField
                v-model="fogNear"
                :min="0"
                :step="0.1"
                @update:model-value="onFogSettingsChanged"
              >
                <NumberFieldContent>
                  <NumberFieldDecrement />
                  <NumberFieldInput class="h-7 w-16 text-xs" />
                  <NumberFieldIncrement />
                </NumberFieldContent>
              </NumberField>
              <NumberField
                v-model="fogFar"
                :min="0"
                :step="1"
                @update:model-value="onFogSettingsChanged"
              >
                <NumberFieldContent>
                  <NumberFieldDecrement />
                  <NumberFieldInput class="h-7 w-16 text-xs" />
                  <NumberFieldIncrement />
                </NumberFieldContent>
              </NumberField>
            </template>

            <NumberField
              v-if="fogType === 'FogExp2'"
              v-model="fogDensity"
              :min="0"
              :max="0.1"
              :step="0.001"
              @update:model-value="onFogSettingsChanged"
            >
              <NumberFieldContent>
                <NumberFieldDecrement />
                <NumberFieldInput class="h-7 w-20 text-xs" />
                <NumberFieldIncrement />
              </NumberFieldContent>
            </NumberField>
          </div>
        </div>
      </div>
    </ScrollArea>
  </div>
</template>
