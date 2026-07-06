<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { activeCameraUuid, activeView } from "./directorState"

const editor = useEditor()
const signals = editor.signals

const camerasVersion = ref(0)
function bumpCameras() {
  camerasVersion.value++
}

onMounted(() => {
  signals.cameraAdded.add(bumpCameras)
  signals.cameraRemoved.add(bumpCameras)
})

onBeforeUnmount(() => {
  signals.cameraAdded.remove(bumpCameras)
  signals.cameraRemoved.remove(bumpCameras)
})

// The editor's own orbit camera (`editor.camera`) is always registered in
// `editor.cameras` too — only the *other* ones are user-placed 机位.
const cameraOptions = computed(() => {
  camerasVersion.value
  return Object.values(editor.cameras).filter(
    (camera: any) => camera !== editor.camera
  ) as any[]
})

function applyViewportCamera() {
  if (activeView.value === "director") {
    editor.setViewportCamera(editor.camera.uuid)
    return
  }

  const options = cameraOptions.value
  if (
    !activeCameraUuid.value ||
    !options.some((camera) => camera.uuid === activeCameraUuid.value)
  ) {
    activeCameraUuid.value = options[0]?.uuid ?? null
  }

  editor.setViewportCamera(activeCameraUuid.value ?? editor.camera.uuid)
}

watch([activeView, activeCameraUuid, cameraOptions], applyViewportCamera, {
  immediate: true
})

function onObjectSelected(object: any) {
  if (activeView.value === "camera" && object?.isCamera) {
    activeCameraUuid.value = object.uuid
  }
}

onMounted(() => signals.objectSelected.add(onObjectSelected))
onBeforeUnmount(() => signals.objectSelected.remove(onObjectSelected))
</script>

<template>
  <div class="flex items-center gap-2">
    <Tabs v-model="activeView">
      <TabsList>
        <TabsTrigger value="director">导演视角</TabsTrigger>
        <TabsTrigger value="camera" :disabled="cameraOptions.length === 0">
          机位视角
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <Select
      v-if="activeView === 'camera' && cameraOptions.length > 1"
      v-model="activeCameraUuid"
    >
      <SelectTrigger size="sm" class="w-36">
        <SelectValue placeholder="选择机位" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          v-for="camera in cameraOptions"
          :key="camera.uuid"
          :value="camera.uuid"
        >
          {{ camera.name || "机位" }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
