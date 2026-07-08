<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

// 编辑器自身的轨道相机（`editor.camera`）也始终注册在
// `editor.cameras` 中——只有*其他*相机才是用户放置的机位。
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

  // 选中了摄像机时，机位视角与选中对象保持同步；否则在无有效机位时默认取第一个。
  const selectedObject = editor.selected
  if (
    selectedObject?.isCamera &&
    options.some((camera) => camera.uuid === selectedObject.uuid)
  ) {
    activeCameraUuid.value = selectedObject.uuid
  } else if (
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
  // 无论当前处于哪种视角，选中摄像机都同步激活机位，
  // 这样从导演视角切到机位视角时能直接透到所选机位。
  if (object?.isCamera) {
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
  </div>
</template>
