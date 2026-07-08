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
import { Video } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { SetPositionCommand } from "@/components/three-editor/commands/SetPositionCommand"
import { SetValueCommand } from "@/components/three-editor/commands/SetValueCommand"
import { activeCameraUuid, activeView } from "./directorState"
import { useCameraThumbnail } from "./useCameraThumbnail"
import {
  applyCameraLookAt,
  deriveAimPoint,
  ensureCameraLookAt,
  getCameraLookAt
} from "./cameraLookAt"

const editor = useEditor()
const signals = editor.signals

// 同 DirectorObjectPropertiesPanel：shallowRef 保持 THREE 对象未被代理，
// 否则由它构建的命令与 editor.selected 的身份比较会失效。
const selected = shallowRef<any>(editor.selected)

const camerasVersion = ref(0)
const graphVersion = ref(0)

// 缩略图版本号：机位/场景相关变化时自增，驱动 useCameraThumbnail 重新渲染。
const thumbVersion = ref(0)

// 用户放置的机位——编辑器自身的轨道相机不算（见 DirectorViewTabs）。
const cameraOptions = computed(() => {
  camerasVersion.value
  return Object.values(editor.cameras).filter(
    (camera: any) => camera !== editor.camera
  ) as any[]
})

// 面板编辑的目标机位：优先取选中的摄像机；机位视角下无选中对象时，
// 取当前正透过的机位。选中非摄像机对象时让位于对象属性面板。
const targetCamera = computed<any>(() => {
  if (selected.value?.isCamera) return selected.value
  if (!selected.value && activeView.value === "camera") {
    return (
      cameraOptions.value.find(
        (camera) => camera.uuid === activeCameraUuid.value
      ) ?? null
    )
  }
  return null
})

// 可作为注视目标的图形：场景根级的非摄像机对象。
const lookTargetOptions = computed(() => {
  graphVersion.value
  return editor.scene.children.filter((object: any) => !object.isCamera)
})

const name = ref("")
const positionX = ref(0)
const positionY = ref(0)
const positionZ = ref(0)
// "manual" 或注视目标对象的 uuid
const lookMode = ref<string>("manual")
const lookX = ref(0)
const lookY = ref(0)
const lookZ = ref(0)
const fov = ref(50)

const lookLocked = computed(() => lookMode.value !== "manual")

const isViewingTarget = computed(
  () =>
    activeView.value === "camera" &&
  targetCamera.value?.uuid === activeCameraUuid.value
)

// 当前机位视角缩略图：随 targetCamera 切换与 thumbVersion 变化重新渲染。
const { thumbnail } = useCameraThumbnail(editor, targetCamera, thumbVersion)

function syncFromCamera(camera: any) {
  name.value = camera.name
  positionX.value = camera.position.x
  positionY.value = camera.position.y
  positionZ.value = camera.position.z
  fov.value = camera.fov ?? 50

  const state = getCameraLookAt(camera)
  if (state) {
    lookMode.value =
      state.mode === "object" && state.targetUuid ? state.targetUuid : "manual"
    lookX.value = state.target.x
    lookY.value = state.target.y
    lookZ.value = state.target.z
  } else {
    // 尚未设置注视状态：展示由当前朝向推导的坐标，但不写入 userData，
    // 用户提交前摄像机行为保持不变。
    const point = deriveAimPoint(camera)
    lookMode.value = "manual"
    lookX.value = point.x
    lookY.value = point.y
    lookZ.value = point.z
  }
}

watch(
  targetCamera,
  (camera) => {
    if (camera) syncFromCamera(camera)
  },
  { immediate: true }
)

function onObjectSelected(object: any) {
  selected.value = object
}

function onObjectChanged(object: any) {
  if (object === targetCamera.value) syncFromCamera(object)
  // 任意对象变动都可能改变机位画面，刷新缩略图（rAF 合并为每帧一次）。
  thumbVersion.value++
}

function bumpCameras() {
  camerasVersion.value++
  thumbVersion.value++
}

function bumpGraph() {
  graphVersion.value++
  thumbVersion.value++
}

function onEditorCleared() {
  selected.value = null
  bumpCameras()
  bumpGraph()
}

onMounted(() => {
  signals.objectSelected.add(onObjectSelected)
  signals.objectChanged.add(onObjectChanged)
  signals.cameraAdded.add(bumpCameras)
  signals.cameraRemoved.add(bumpCameras)
  signals.sceneGraphChanged.add(bumpGraph)
  signals.sceneBackgroundChanged.add(bumpGraph)
  signals.sceneEnvironmentChanged.add(bumpGraph)
  signals.sceneFogChanged.add(bumpGraph)
  signals.sceneFogSettingsChanged.add(bumpGraph)
  signals.rendererUpdated.add(bumpGraph)
  signals.editorCleared.add(onEditorCleared)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.objectChanged.remove(onObjectChanged)
  signals.cameraAdded.remove(bumpCameras)
  signals.cameraRemoved.remove(bumpCameras)
  signals.sceneGraphChanged.remove(bumpGraph)
  signals.sceneBackgroundChanged.remove(bumpGraph)
  signals.sceneEnvironmentChanged.remove(bumpGraph)
  signals.sceneFogChanged.remove(bumpGraph)
  signals.sceneFogSettingsChanged.remove(bumpGraph)
  signals.rendererUpdated.remove(bumpGraph)
  signals.editorCleared.remove(onEditorCleared)
})

function commitName() {
  const camera = targetCamera.value
  if (!camera || camera.name === name.value) return
  editor.execute(new SetValueCommand(editor, camera, "name", name.value))
}

function switchCamera(uuid: any) {
  if (typeof uuid !== "string") return
  const camera = cameraOptions.value.find((option) => option.uuid === uuid)
  if (!camera || camera === targetCamera.value) return
  if (activeView.value === "camera") activeCameraUuid.value = uuid
  if (selected.value?.isCamera) editor.select(camera)
}

function commitPosition() {
  const camera = targetCamera.value
  if (!camera) return
  const newPosition = new THREE.Vector3(
    positionX.value,
    positionY.value,
    positionZ.value
  )
  if (camera.position.distanceTo(newPosition) >= 0.001) {
    // 移动后 useCameraLookAt 会通过 objectChanged 重新对准注视点
    editor.execute(new SetPositionCommand(editor, camera, newPosition))
  }
}

function commitLookMode(value: any) {
  const camera = targetCamera.value
  if (!camera || typeof value !== "string") return
  const state = ensureCameraLookAt(camera)
  if (value === "manual") {
    // state.target 缓存着最近一次注视点，切回手动时朝向保持不变
    state.mode = "manual"
    state.targetUuid = null
  } else {
    state.mode = "object"
    state.targetUuid = value
  }
  if (applyCameraLookAt(editor, camera)) {
    signals.objectChanged.dispatch(camera)
  }
  syncFromCamera(camera)
}

function commitLookCoords() {
  const camera = targetCamera.value
  if (!camera || lookLocked.value) return
  const state = ensureCameraLookAt(camera)
  state.mode = "manual"
  state.targetUuid = null
  state.target = { x: lookX.value, y: lookY.value, z: lookZ.value }
  if (applyCameraLookAt(editor, camera)) {
    signals.objectChanged.dispatch(camera)
  }
}

function commitFov(value: number) {
  const camera = targetCamera.value
  if (!camera) return
  fov.value = value
  if (Math.abs(camera.fov - value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, camera, "fov", value))
    camera.updateProjectionMatrix()
  }
}

function previewFromCamera() {
  const camera = targetCamera.value
  if (!camera) return
  activeView.value = "camera"
  activeCameraUuid.value = camera.uuid
}
</script>

<template>
  <ScrollArea v-show="targetCamera" class="h-full">
    <div v-if="targetCamera" class="flex flex-col gap-4 p-3">
      <div class="text-xs font-medium text-muted-foreground">摄像机</div>

      <div class="space-y-2">
        <Label class="text-xs">机位预览</Label>
        <div
          class="relative aspect-video w-full overflow-hidden rounded-md border border-input bg-black"
        >
          <img
            v-if="thumbnail"
            :src="thumbnail"
            alt="机位预览"
            class="size-full object-cover"
          />
        </div>
      </div>

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
        <Label class="text-xs">切换机位</Label>
        <Select
          :model-value="targetCamera.uuid"
          @update:model-value="switchCamera"
        >
          <SelectTrigger size="sm" class="w-full">
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

      <div class="space-y-2">
        <Label class="text-xs">位置</Label>
        <div class="grid grid-cols-3 gap-2">
          <NumberField
            v-model="positionX"
            :step="0.1"
            @update:model-value="commitPosition"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="positionY"
            :step="0.1"
            @update:model-value="commitPosition"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="positionZ"
            :step="0.1"
            @update:model-value="commitPosition"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
        </div>
      </div>

      <Separator />

      <div class="space-y-2">
        <Label class="text-xs">注视目标</Label>
        <Select :model-value="lookMode" @update:model-value="commitLookMode">
          <SelectTrigger size="sm" class="w-full">
            <SelectValue placeholder="选择注视目标" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">手动坐标</SelectItem>
            <SelectItem
              v-for="object in lookTargetOptions"
              :key="object.uuid"
              :value="object.uuid"
            >
              {{ object.name || object.type }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label class="text-xs">注视坐标</Label>
        <div class="grid grid-cols-3 gap-2">
          <NumberField
            v-model="lookX"
            :step="0.1"
            :disabled="lookLocked"
            @update:model-value="commitLookCoords"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="lookY"
            :step="0.1"
            :disabled="lookLocked"
            @update:model-value="commitLookCoords"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="lookZ"
            :step="0.1"
            :disabled="lookLocked"
            @update:model-value="commitLookCoords"
          >
            <NumberFieldContent
              ><NumberFieldInput class="h-7 text-xs"
            /></NumberFieldContent>
          </NumberField>
        </div>
        <p v-if="lookLocked" class="text-[10px] text-muted-foreground">
          跟随注视目标移动，坐标不可手动调整
        </p>
      </div>

      <Separator />

      <div class="space-y-1">
        <div
          class="flex items-center justify-between text-[10px] text-muted-foreground"
        >
          <span>视野角度 (FOV)</span>
          <span>{{ fov.toFixed(1) }}</span>
        </div>
        <Slider
          :model-value="[fov]"
          :min="15"
          :max="90"
          :step="1"
          @update:model-value="(v) => commitFov(v?.[0] ?? fov)"
        />
      </div>

      <Button
        v-if="!isViewingTarget"
        variant="outline"
        size="sm"
        class="w-full"
        @click="previewFromCamera"
      >
        <Video class="size-3.5" />
        切换到此机位视角
      </Button>
    </div>
  </ScrollArea>
</template>
