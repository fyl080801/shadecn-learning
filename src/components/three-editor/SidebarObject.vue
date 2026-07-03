<script setup lang="ts">
// @ts-nocheck
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"

import { SetUuidCommand } from "./commands/SetUuidCommand"
import { SetValueCommand } from "./commands/SetValueCommand"
import { SetPositionCommand } from "./commands/SetPositionCommand"
import { SetRotationCommand } from "./commands/SetRotationCommand"
import { SetScaleCommand } from "./commands/SetScaleCommand"
import { SetColorCommand } from "./commands/SetColorCommand"
import { SetShadowValueCommand } from "./commands/SetShadowValueCommand"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput
} from "@/components/ui/number-field"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const selected = ref<any>(null)

const objectType = ref("")
const objectUUID = ref("")
const objectName = ref("")

const positionX = ref(0)
const positionY = ref(0)
const positionZ = ref(0)

const rotationX = ref(0)
const rotationY = ref(0)
const rotationZ = ref(0)

const scaleX = ref(1)
const scaleY = ref(1)
const scaleZ = ref(1)

const fov = ref(0)
const left = ref(0)
const right = ref(0)
const top = ref(0)
const bottom = ref(0)
const near = ref(0)
const far = ref(0)

const intensity = ref(0)
const color = ref("#000000")
const groundColor = ref("#000000")

const distance = ref(0)
const angle = ref(0)
const penumbra = ref(0)
const decay = ref(0)

const castShadow = ref(false)
const receiveShadow = ref(false)
const shadowIntensity = ref(0)
const shadowBias = ref(0)
const shadowNormalBias = ref(0)
const shadowRadius = ref(1)

const visible = ref(true)
const frustumCulled = ref(true)
const renderOrder = ref(0)

const userData = ref("")
const userDataValid = ref(true)

// ----- visibility of conditional rows -----

const showFov = computed(() => selected.value?.fov !== undefined)
const showLeft = computed(() => selected.value?.left !== undefined)
const showRight = computed(() => selected.value?.right !== undefined)
const showTop = computed(() => selected.value?.top !== undefined)
const showBottom = computed(() => selected.value?.bottom !== undefined)
const showNear = computed(() => selected.value?.near !== undefined)
const showFar = computed(() => selected.value?.far !== undefined)
const showIntensity = computed(() => selected.value?.intensity !== undefined)
const showColor = computed(() => selected.value?.color !== undefined)
const showGroundColor = computed(
  () => selected.value?.groundColor !== undefined
)
const showDistance = computed(() => selected.value?.distance !== undefined)
const showAngle = computed(() => selected.value?.angle !== undefined)
const showPenumbra = computed(() => selected.value?.penumbra !== undefined)
const showDecay = computed(() => selected.value?.decay !== undefined)

const showRotationScale = computed(() => !selected.value?.isLight)

const showShadowRow = computed(
  () =>
    selected.value?.castShadow !== undefined &&
    !selected.value?.isAmbientLight &&
    !selected.value?.isHemisphereLight
)
const showReceiveShadow = computed(
  () => selected.value?.receiveShadow !== undefined && !selected.value?.isLight
)
const showShadowDetails = computed(() => selected.value?.shadow !== undefined)

// ----- helpers -----

function hexToInt(hex: string) {
  return parseInt(hex.replace("#", ""), 16)
}

function intToHex(value: number) {
  return "#" + value.toString(16).padStart(6, "0")
}

// ----- update object from UI -----

function update() {
  const object = editor.selected

  if (object === null) return

  const newPosition = new THREE.Vector3(
    positionX.value,
    positionY.value,
    positionZ.value
  )
  if (object.position.distanceTo(newPosition) >= 0.01) {
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
      .distanceTo(new THREE.Vector3().setFromEuler(newRotation)) >= 0.01
  ) {
    editor.execute(new SetRotationCommand(editor, object, newRotation))
  }

  const newScale = new THREE.Vector3(scaleX.value, scaleY.value, scaleZ.value)
  if (object.scale.distanceTo(newScale) >= 0.01) {
    editor.execute(new SetScaleCommand(editor, object, newScale))
  }

  if (object.fov !== undefined && Math.abs(object.fov - fov.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "fov", fov.value))
    object.updateProjectionMatrix()
  }

  if (object.left !== undefined && Math.abs(object.left - left.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "left", left.value))
    object.updateProjectionMatrix()
  }

  if (
    object.right !== undefined &&
    Math.abs(object.right - right.value) >= 0.01
  ) {
    editor.execute(new SetValueCommand(editor, object, "right", right.value))
    object.updateProjectionMatrix()
  }

  if (object.top !== undefined && Math.abs(object.top - top.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "top", top.value))
    object.updateProjectionMatrix()
  }

  if (
    object.bottom !== undefined &&
    Math.abs(object.bottom - bottom.value) >= 0.01
  ) {
    editor.execute(new SetValueCommand(editor, object, "bottom", bottom.value))
    object.updateProjectionMatrix()
  }

  if (object.near !== undefined && Math.abs(object.near - near.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "near", near.value))
    if (object.isOrthographicCamera) object.updateProjectionMatrix()
  }

  if (object.far !== undefined && Math.abs(object.far - far.value) >= 0.01) {
    editor.execute(new SetValueCommand(editor, object, "far", far.value))
    if (object.isOrthographicCamera) object.updateProjectionMatrix()
  }

  if (
    object.intensity !== undefined &&
    Math.abs(object.intensity - intensity.value) >= 0.01
  ) {
    editor.execute(
      new SetValueCommand(editor, object, "intensity", intensity.value)
    )
  }

  if (
    object.color !== undefined &&
    object.color.getHex() !== hexToInt(color.value)
  ) {
    editor.execute(
      new SetColorCommand(editor, object, "color", hexToInt(color.value))
    )
  }

  if (
    object.groundColor !== undefined &&
    object.groundColor.getHex() !== hexToInt(groundColor.value)
  ) {
    editor.execute(
      new SetColorCommand(
        editor,
        object,
        "groundColor",
        hexToInt(groundColor.value)
      )
    )
  }

  if (
    object.distance !== undefined &&
    Math.abs(object.distance - distance.value) >= 0.01
  ) {
    editor.execute(
      new SetValueCommand(editor, object, "distance", distance.value)
    )
  }

  if (
    object.angle !== undefined &&
    Math.abs(object.angle - angle.value) >= 0.01
  ) {
    editor.execute(new SetValueCommand(editor, object, "angle", angle.value))
  }

  if (
    object.penumbra !== undefined &&
    Math.abs(object.penumbra - penumbra.value) >= 0.01
  ) {
    editor.execute(
      new SetValueCommand(editor, object, "penumbra", penumbra.value)
    )
  }

  if (
    object.decay !== undefined &&
    Math.abs(object.decay - decay.value) >= 0.01
  ) {
    editor.execute(new SetValueCommand(editor, object, "decay", decay.value))
  }

  if (object.visible !== visible.value) {
    editor.execute(
      new SetValueCommand(editor, object, "visible", visible.value)
    )
  }

  if (object.frustumCulled !== frustumCulled.value) {
    editor.execute(
      new SetValueCommand(editor, object, "frustumCulled", frustumCulled.value)
    )
  }

  if (object.renderOrder !== renderOrder.value) {
    editor.execute(
      new SetValueCommand(editor, object, "renderOrder", renderOrder.value)
    )
  }

  if (
    object.castShadow !== undefined &&
    object.castShadow !== castShadow.value
  ) {
    editor.execute(
      new SetValueCommand(editor, object, "castShadow", castShadow.value)
    )
  }

  if (object.receiveShadow !== receiveShadow.value) {
    if (object.material !== undefined) object.material.needsUpdate = true
    editor.execute(
      new SetValueCommand(editor, object, "receiveShadow", receiveShadow.value)
    )
  }

  if (object.shadow !== undefined) {
    if (object.shadow.intensity !== shadowIntensity.value) {
      editor.execute(
        new SetShadowValueCommand(
          editor,
          object,
          "intensity",
          shadowIntensity.value
        )
      )
    }

    if (object.shadow.bias !== shadowBias.value) {
      editor.execute(
        new SetShadowValueCommand(editor, object, "bias", shadowBias.value)
      )
    }

    if (object.shadow.normalBias !== shadowNormalBias.value) {
      editor.execute(
        new SetShadowValueCommand(
          editor,
          object,
          "normalBias",
          shadowNormalBias.value
        )
      )
    }

    if (object.shadow.radius !== shadowRadius.value) {
      editor.execute(
        new SetShadowValueCommand(editor, object, "radius", shadowRadius.value)
      )
    }
  }

  try {
    const parsed = JSON.parse(userData.value)
    if (JSON.stringify(object.userData) !== JSON.stringify(parsed)) {
      editor.execute(new SetValueCommand(editor, object, "userData", parsed))
    }
  } catch (error) {
    console.warn(error)
  }
}

function onUuidRenew() {
  const object = editor.selected
  if (object === null) return

  objectUUID.value = THREE.MathUtils.generateUUID()
  editor.execute(new SetUuidCommand(editor, object, objectUUID.value))
}

function onUserDataInput() {
  try {
    JSON.parse(userData.value)
    userDataValid.value = true
  } catch (error) {
    userDataValid.value = false
  }
}

function exportJson() {
  const object = editor.selected
  if (object === null) return

  let output = object.toJSON()

  try {
    output = JSON.stringify(output, null, "\t")
    output = output.replace(/[\n\t]+([\d\.e\-\[\]]+)/g, "$1")
  } catch (error) {
    output = JSON.stringify(output)
  }

  editor.utils.save(new Blob([output]), `${objectName.value || "object"}.json`)
}

// ----- sync UI from object -----

function syncFromObject(object: any) {
  objectType.value = object.type
  objectUUID.value = object.uuid
  objectName.value = object.name

  positionX.value = object.position.x
  positionY.value = object.position.y
  positionZ.value = object.position.z

  rotationX.value = object.rotation.x * THREE.MathUtils.RAD2DEG
  rotationY.value = object.rotation.y * THREE.MathUtils.RAD2DEG
  rotationZ.value = object.rotation.z * THREE.MathUtils.RAD2DEG

  scaleX.value = object.scale.x
  scaleY.value = object.scale.y
  scaleZ.value = object.scale.z

  if (object.fov !== undefined) fov.value = object.fov
  if (object.left !== undefined) left.value = object.left
  if (object.right !== undefined) right.value = object.right
  if (object.top !== undefined) top.value = object.top
  if (object.bottom !== undefined) bottom.value = object.bottom
  if (object.near !== undefined) near.value = object.near
  if (object.far !== undefined) far.value = object.far
  if (object.intensity !== undefined) intensity.value = object.intensity
  if (object.color !== undefined) color.value = intToHex(object.color.getHex())
  if (object.groundColor !== undefined)
    groundColor.value = intToHex(object.groundColor.getHex())
  if (object.distance !== undefined) distance.value = object.distance
  if (object.angle !== undefined) angle.value = object.angle
  if (object.penumbra !== undefined) penumbra.value = object.penumbra
  if (object.decay !== undefined) decay.value = object.decay

  if (object.castShadow !== undefined) castShadow.value = object.castShadow
  receiveShadow.value = object.receiveShadow ?? false

  if (object.shadow !== undefined) {
    shadowIntensity.value = object.shadow.intensity
    shadowBias.value = object.shadow.bias
    shadowNormalBias.value = object.shadow.normalBias
    shadowRadius.value = object.shadow.radius
  }

  visible.value = object.visible
  frustumCulled.value = object.frustumCulled
  renderOrder.value = object.renderOrder

  try {
    userData.value = JSON.stringify(object.userData, null, "  ")
  } catch (error) {
    console.log(error)
  }
  userDataValid.value = true
}

function onObjectSelected(object: any) {
  selected.value = object

  if (object !== null) {
    syncFromObject(object)
  }
}

function onObjectChanged(object: any) {
  if (object !== editor.selected) return
  syncFromObject(object)
}

onMounted(() => {
  selected.value = editor.selected
  if (selected.value !== null) syncFromObject(selected.value)

  signals.objectSelected.add(onObjectSelected)
  signals.objectChanged.add(onObjectChanged)
  signals.refreshSidebarObject3D.add(onObjectChanged)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.objectChanged.remove(onObjectChanged)
  signals.refreshSidebarObject3D.remove(onObjectChanged)
})
</script>

<template>
  <div v-if="selected" class="te-sidebar-object space-y-3 p-3">
    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/type")
      }}</Label>
      <span class="text-xs">{{ objectType }}</span>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/uuid")
      }}</Label>
      <input
        :value="objectUUID"
        type="text"
        disabled
        class="border-input h-7 w-[110px] rounded-md border bg-transparent px-2 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="onUuidRenew"
      >
        {{ t("sidebar/object/new") }}
      </Button>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/name")
      }}</Label>
      <input
        v-model="objectName"
        type="text"
        class="border-input h-7 w-[150px] rounded-md border bg-transparent px-2 text-xs"
        @change="update"
      />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/position")
      }}</Label>
      <div class="grid flex-1 grid-cols-3 gap-1">
        <NumberField
          v-model="positionX"
          :step="0.1"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField
          v-model="positionY"
          :step="0.1"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField
          v-model="positionZ"
          :step="0.1"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </div>

    <div v-if="showRotationScale" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/rotation")
      }}</Label>
      <div class="grid flex-1 grid-cols-3 gap-1">
        <NumberField
          v-model="rotationX"
          :step="10"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField
          v-model="rotationY"
          :step="10"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField
          v-model="rotationZ"
          :step="10"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </div>

    <div v-if="showRotationScale" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/scale")
      }}</Label>
      <div class="grid flex-1 grid-cols-3 gap-1">
        <NumberField v-model="scaleX" :step="0.1" @update:model-value="update">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField v-model="scaleY" :step="0.1" @update:model-value="update">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField v-model="scaleZ" :step="0.1" @update:model-value="update">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </div>

    <div v-if="showFov" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{ t("sidebar/object/fov") }}</Label>
      <NumberField v-model="fov" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showLeft" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/left")
      }}</Label>
      <NumberField v-model="left" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showRight" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/right")
      }}</Label>
      <NumberField v-model="right" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showTop" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{ t("sidebar/object/top") }}</Label>
      <NumberField v-model="top" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showBottom" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/bottom")
      }}</Label>
      <NumberField v-model="bottom" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showNear" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/near")
      }}</Label>
      <NumberField v-model="near" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showFar" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{ t("sidebar/object/far") }}</Label>
      <NumberField v-model="far" class="w-24" @update:model-value="update">
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showIntensity" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/intensity")
      }}</Label>
      <NumberField
        v-model="intensity"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showColor" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/color")
      }}</Label>
      <input
        v-model="color"
        type="color"
        class="border-input h-7 w-10 rounded-md border"
        @input="update"
      />
    </div>

    <div v-if="showGroundColor" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/groundcolor")
      }}</Label>
      <input
        v-model="groundColor"
        type="color"
        class="border-input h-7 w-10 rounded-md border"
        @input="update"
      />
    </div>

    <div v-if="showDistance" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/distance")
      }}</Label>
      <NumberField
        v-model="distance"
        :min="0"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showAngle" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/angle")
      }}</Label>
      <NumberField
        v-model="angle"
        :min="0"
        :max="Math.PI / 2"
        :step="0.01"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showPenumbra" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/penumbra")
      }}</Label>
      <NumberField
        v-model="penumbra"
        :min="0"
        :max="1"
        :step="0.01"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showDecay" class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/decay")
      }}</Label>
      <NumberField
        v-model="decay"
        :min="0"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div v-if="showShadowRow" class="flex items-center gap-4">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/shadow")
      }}</Label>
      <label class="flex items-center gap-1 text-xs">
        <Checkbox v-model="castShadow" @update:model-value="update" />
        {{ t("sidebar/object/cast") }}
      </label>
      <label v-if="showReceiveShadow" class="flex items-center gap-1 text-xs">
        <Checkbox v-model="receiveShadow" @update:model-value="update" />
        {{ t("sidebar/object/receive") }}
      </label>
    </div>

    <template v-if="showShadowDetails">
      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">
          {{ t("sidebar/object/shadowIntensity") }}
        </Label>
        <NumberField
          v-model="shadowIntensity"
          :min="0"
          :max="1"
          :step="0.01"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">
          {{ t("sidebar/object/shadowBias") }}
        </Label>
        <NumberField
          v-model="shadowBias"
          :step="0.0001"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">
          {{ t("sidebar/object/shadowNormalBias") }}
        </Label>
        <NumberField
          v-model="shadowNormalBias"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">
          {{ t("sidebar/object/shadowRadius") }}
        </Label>
        <NumberField
          v-model="shadowRadius"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>
    </template>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">{{
        t("sidebar/object/visible")
      }}</Label>
      <Checkbox v-model="visible" @update:model-value="update" />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">
        {{ t("sidebar/object/frustumcull") }}
      </Label>
      <Checkbox v-model="frustumCulled" @update:model-value="update" />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-24 shrink-0 text-xs">
        {{ t("sidebar/object/renderorder") }}
      </Label>
      <NumberField
        v-model="renderOrder"
        :format-options="{ maximumFractionDigits: 0 }"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div class="space-y-1">
      <Label class="text-xs">{{ t("sidebar/object/userdata") }}</Label>
      <Textarea
        v-model="userData"
        rows="4"
        class="text-xs"
        :class="userDataValid ? '' : 'border-destructive'"
        @change="update"
        @input="onUserDataInput"
      />
    </div>

    <Button size="sm" variant="outline" class="text-xs" @click="exportJson">
      {{ t("sidebar/object/export") }}
    </Button>
  </div>
</template>
