<script setup lang="ts">
// @ts-nocheck
import { reactive, watch } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"
import GeometryPointsField from "./GeometryPointsField.vue"

import { Label } from "@/components/ui/label"
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

const RAD2DEG = THREE.MathUtils.RAD2DEG
const DEG2RAD = THREE.MathUtils.DEG2RAD

const values = reactive({
  segments: 12,
  phiStart: 0,
  phiLength: 360,
  points: [] as Array<{ x: number; y: number }>
})

function refresh() {
  const parameters = props.object?.geometry?.parameters
  if (!parameters) return

  values.segments = parameters.segments
  values.phiStart = parameters.phiStart * RAD2DEG
  values.phiLength = parameters.phiLength * RAD2DEG
  values.points = parameters.points.map((p: any) => ({ x: p.x, y: p.y }))
}

function update() {
  const object = props.object
  if (!object?.geometry) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.LatheGeometry(
        values.points.map((p) => new THREE.Vector2(p.x, p.y)),
        values.segments,
        values.phiStart * DEG2RAD,
        values.phiLength * DEG2RAD
      )
    )
  )
}

function onPointsChange(points: Array<{ x: number; y: number }>) {
  values.points = points
  update()
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
        t("sidebar/geometry/lathe_geometry/segments")
      }}</Label>
      <NumberField
        v-model="values.segments"
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
        t("sidebar/geometry/lathe_geometry/phistart")
      }}</Label>
      <NumberField
        v-model="values.phiStart"
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
        t("sidebar/geometry/lathe_geometry/philength")
      }}</Label>
      <NumberField
        v-model="values.phiLength"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-7 text-xs" />
        </NumberFieldContent>
      </NumberField>
    </div>

    <div class="space-y-1">
      <Label class="text-xs">{{
        t("sidebar/geometry/lathe_geometry/points")
      }}</Label>
      <GeometryPointsField
        :model-value="values.points"
        :dimension="2"
        @update:model-value="onPointsChange"
      />
    </div>
  </div>
</template>
