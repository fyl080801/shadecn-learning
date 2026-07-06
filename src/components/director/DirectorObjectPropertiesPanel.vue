<script setup lang="ts">
// @ts-nocheck
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"
import { Video } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { SetPositionCommand } from "@/components/three-editor/commands/SetPositionCommand"
import { SetRotationCommand } from "@/components/three-editor/commands/SetRotationCommand"
import { SetScaleCommand } from "@/components/three-editor/commands/SetScaleCommand"
import { SetValueCommand } from "@/components/three-editor/commands/SetValueCommand"
import { activeCameraUuid, activeView } from "./directorState"

const editor = useEditor()
const signals = editor.signals

const selected = ref<any>(editor.selected)

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
const visible = ref(true)
const locked = ref(false)

const fov = ref(50)
const near = ref(0.1)
const far = ref(1000)

const isCamera = computed(() => !!selected.value?.isCamera)

function syncFromObject(object: any) {
  name.value = object.name
  positionX.value = object.position.x
  positionY.value = object.position.y
  positionZ.value = object.position.z
  rotationX.value = object.rotation.x * THREE.MathUtils.RAD2DEG
  rotationY.value = object.rotation.y * THREE.MathUtils.RAD2DEG
  rotationZ.value = object.rotation.z * THREE.MathUtils.RAD2DEG
  scaleX.value = object.scale.x
  scaleY.value = object.scale.y
  scaleZ.value = object.scale.z
  visible.value = object.visible
  locked.value = !!object.userData?.locked

  if (object.isCamera) {
    fov.value = object.fov ?? 50
    near.value = object.near ?? 0.1
    far.value = object.far ?? 1000
  }
}

function onObjectSelected(object: any) {
  selected.value = object
  if (object) syncFromObject(object)
}

function onObjectChanged(object: any) {
  if (object === editor.selected) syncFromObject(object)
}

onMounted(() => {
  if (selected.value) syncFromObject(selected.value)
  signals.objectSelected.add(onObjectSelected)
  signals.objectChanged.add(onObjectChanged)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.objectChanged.remove(onObjectChanged)
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

  const newScale = new THREE.Vector3(scaleX.value, scaleY.value, scaleZ.value)
  if (object.scale.distanceTo(newScale) >= 0.001) {
    editor.execute(new SetScaleCommand(editor, object, newScale))
  }
}

function commitCameraFields() {
  const object = selected.value
  if (!object?.isCamera) return

  if (Math.abs(object.fov - fov.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "fov", fov.value))
    object.updateProjectionMatrix()
  }
  if (Math.abs(object.near - near.value) >= 0.001) {
    editor.execute(new SetValueCommand(editor, object, "near", near.value))
    object.updateProjectionMatrix()
  }
  if (Math.abs(object.far - far.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "far", far.value))
    object.updateProjectionMatrix()
  }
}

function toggleVisible(value: boolean) {
  const object = selected.value
  if (!object) return
  editor.execute(new SetValueCommand(editor, object, "visible", value))
}

function toggleLocked(value: boolean) {
  const object = selected.value
  if (!object) return
  object.userData.locked = value
  if (value) editor.deselect()
  signals.sceneGraphChanged.dispatch()
}

function previewFromCamera() {
  const object = selected.value
  if (!object?.isCamera) return
  activeView.value = "camera"
  activeCameraUuid.value = object.uuid
}
</script>

<template>
  <ScrollArea v-show="selected" class="h-full">
    <div v-if="selected" class="flex flex-col gap-4 p-3">
      <div class="text-xs font-medium text-muted-foreground">图形属性</div>

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
      </div>

      <Separator />

      <div v-if="isCamera" class="space-y-2">
        <Label class="text-xs">机位参数</Label>
        <div class="grid grid-cols-3 gap-2">
          <div class="space-y-1">
            <span class="text-[10px] text-muted-foreground">FOV</span>
            <NumberField
              v-model="fov"
              :step="1"
              :min="1"
              :max="170"
              @update:model-value="commitCameraFields"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>
          <div class="space-y-1">
            <span class="text-[10px] text-muted-foreground">Near</span>
            <NumberField
              v-model="near"
              :step="0.1"
              :min="0.001"
              @update:model-value="commitCameraFields"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>
          <div class="space-y-1">
            <span class="text-[10px] text-muted-foreground">Far</span>
            <NumberField
              v-model="far"
              :step="10"
              @update:model-value="commitCameraFields"
            >
              <NumberFieldContent
                ><NumberFieldInput class="h-7 text-xs"
              /></NumberFieldContent>
            </NumberField>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          class="w-full"
          @click="previewFromCamera"
        >
          <Video class="size-3.5" />
          切换到此机位视角
        </Button>

        <Separator />
      </div>

      <div class="flex items-center justify-between">
        <Label class="text-xs">可见性</Label>
        <Switch :model-value="visible" @update:model-value="toggleVisible" />
      </div>

      <div class="flex items-center justify-between">
        <Label class="text-xs">锁定</Label>
        <Switch :model-value="locked" @update:model-value="toggleLocked" />
      </div>
    </div>
  </ScrollArea>
</template>
