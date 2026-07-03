<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

const props = defineProps<{
  editor: any
}>()

const signals = props.editor.signals

const shadingOptions = [
  { value: "realistic", label: "realistic" },
  { value: "solid", label: "solid" },
  { value: "normals", label: "normals" },
  { value: "wireframe", label: "wireframe" }
]

const cameraOptions = ref<{ value: string; label: string }[]>([])
const selectedCamera = ref("")
const shading = ref("solid")

function updateCameraList() {
  const cameras = props.editor.cameras
  const options = Object.keys(cameras).map((key) => ({
    value: cameras[key].uuid,
    label: cameras[key].name
  }))
  cameraOptions.value = options

  const hasSelected = options.some(
    (option) => option.value === props.editor.viewportCamera.uuid
  )
  return hasSelected ? props.editor.viewportCamera : props.editor.camera
}

function update() {
  const selected = updateCameraList()
  selectedCamera.value = selected.uuid
  props.editor.setViewportCamera(selected.uuid)
}

function onCameraSelect(value: unknown) {
  selectedCamera.value = value as string
  props.editor.setViewportCamera(value)
}

function onShadingSelect(value: unknown) {
  shading.value = value as string
  props.editor.setViewportShading(value)
}

function onObjectChanged(object: any) {
  if (object?.isCamera) updateCameraList()
}

function onEditorCleared() {
  update()
  shading.value = "solid"
  props.editor.setViewportShading("solid")
}

onMounted(() => {
  signals.cameraAdded.add(update)
  signals.cameraRemoved.add(update)
  signals.objectChanged.add(onObjectChanged)
  signals.editorCleared.add(onEditorCleared)
  signals.cameraResetted.add(update)

  update()
})

onBeforeUnmount(() => {
  signals.cameraAdded.remove(update)
  signals.cameraRemoved.remove(update)
  signals.objectChanged.remove(onObjectChanged)
  signals.editorCleared.remove(onEditorCleared)
  signals.cameraResetted.remove(update)
})
</script>

<template>
  <div class="absolute top-[10px] right-[10px] z-10 flex gap-2">
    <Select :model-value="selectedCamera" @update:model-value="onCameraSelect">
      <SelectTrigger size="sm" class="bg-background/80 w-[140px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          v-for="option in cameraOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </SelectItem>
      </SelectContent>
    </Select>

    <Select :model-value="shading" @update:model-value="onShadingSelect">
      <SelectTrigger size="sm" class="bg-background/80 w-[120px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          v-for="option in shadingOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
