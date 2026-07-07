<script setup lang="ts">
import { reactive, watch } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput
} from "@/components/ui/number-field"

const props = defineProps<{ object: any }>()

const editor = useEditor()
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const values = reactive({
  curveSegments: 12,
  steps: 1,
  depth: 1,
  bevelEnabled: true,
  bevelThickness: 0.2,
  bevelSize: 0.1,
  bevelOffset: 0,
  bevelSegments: 3
})

function refresh() {
  const options = props.object?.geometry?.parameters?.options
  if (!options) return

  const bevelThickness = options.bevelThickness ?? 0.2

  values.curveSegments = options.curveSegments ?? 12
  values.steps = options.steps ?? 1
  values.depth = options.depth ?? 1
  values.bevelEnabled = options.bevelEnabled
  values.bevelThickness = bevelThickness
  values.bevelSize = options.bevelSize ?? bevelThickness - 0.1
  values.bevelOffset = options.bevelOffset ?? 0
  values.bevelSegments = options.bevelSegments ?? 3
}

function update() {
  const object = props.object
  const parameters = object?.geometry?.parameters
  if (!parameters) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.ExtrudeGeometry(parameters.shapes, {
        curveSegments: values.curveSegments,
        steps: values.steps,
        depth: values.depth,
        bevelEnabled: values.bevelEnabled,
        bevelThickness: values.bevelThickness,
        bevelSize: values.bevelSize,
        bevelOffset: values.bevelOffset,
        bevelSegments: values.bevelSegments
      })
    )
  )
}

function toShape() {
  const object = props.object
  const parameters = object?.geometry?.parameters
  if (!parameters) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.ShapeGeometry(parameters.shapes, values.curveSegments)
    )
  )
}

watch(
  () => props.object,
  () => refresh(),
  { immediate: true }
)

defineExpose({ refresh })
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/extrude_geometry/curveSegments")
      }}</Label>
      <NumberField
        v-model="values.curveSegments"
        :min="1"
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
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/extrude_geometry/steps")
      }}</Label>
      <NumberField
        v-model="values.steps"
        :min="1"
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
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/extrude_geometry/depth")
      }}</Label>
      <NumberField
        v-model="values.depth"
        :min="1"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-7 text-xs" />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/extrude_geometry/bevelEnabled")
      }}</Label>
      <Checkbox v-model="values.bevelEnabled" @update:model-value="update" />
    </div>

    <template v-if="values.bevelEnabled">
      <div class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{
          t("sidebar/geometry/extrude_geometry/bevelThickness")
        }}</Label>
        <NumberField
          v-model="values.bevelThickness"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{
          t("sidebar/geometry/extrude_geometry/bevelSize")
        }}</Label>
        <NumberField
          v-model="values.bevelSize"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{
          t("sidebar/geometry/extrude_geometry/bevelOffset")
        }}</Label>
        <NumberField
          v-model="values.bevelOffset"
          class="w-24"
          @update:model-value="update"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{
          t("sidebar/geometry/extrude_geometry/bevelSegments")
        }}</Label>
        <NumberField
          v-model="values.bevelSegments"
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
    </template>

    <Button size="sm" variant="outline" class="text-xs" @click="toShape">
      {{ t("sidebar/geometry/extrude_geometry/shape") }}
    </Button>
  </div>
</template>
