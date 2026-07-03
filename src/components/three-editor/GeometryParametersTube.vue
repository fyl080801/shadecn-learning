<script setup lang="ts">
// @ts-nocheck
import { computed, reactive, watch } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"
import GeometryPointsField from "./GeometryPointsField.vue"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
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

const curveTypeOptions = ["centripetal", "chordal", "catmullrom"]

const values = reactive({
  points: [] as Array<{ x: number; y: number; z: number }>,
  radius: 1,
  tubularSegments: 64,
  radialSegments: 8,
  closed: false,
  curveType: "centripetal",
  tension: 0.5
})

const showTension = computed(() => values.curveType === "catmullrom")

function refresh() {
  const parameters = props.object?.geometry?.parameters
  if (!parameters) return

  values.points = parameters.path.points.map((p: any) => ({
    x: p.x,
    y: p.y,
    z: p.z
  }))
  values.radius = parameters.radius
  values.tubularSegments = parameters.tubularSegments
  values.radialSegments = parameters.radialSegments
  values.closed = parameters.closed
  values.curveType = parameters.path.curveType
  values.tension = parameters.path.tension
}

function update() {
  const object = props.object
  if (!object?.geometry) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          values.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
          values.closed,
          values.curveType,
          values.tension
        ),
        values.tubularSegments,
        values.radius,
        values.radialSegments,
        values.closed
      )
    )
  )
}

function onPointsChange(points: Array<{ x: number; y: number; z: number }>) {
  values.points = points
  update()
}

function onCurveTypeChange(value: string) {
  values.curveType = value
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
    <div class="space-y-1">
      <Label class="text-xs">{{
        t("sidebar/geometry/tube_geometry/path")
      }}</Label>
      <GeometryPointsField
        :model-value="values.points"
        :dimension="3"
        @update:model-value="onPointsChange"
      />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/tube_geometry/radius")
      }}</Label>
      <NumberField
        v-model="values.radius"
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
        t("sidebar/geometry/tube_geometry/tubularsegments")
      }}</Label>
      <NumberField
        v-model="values.tubularSegments"
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
        t("sidebar/geometry/tube_geometry/radialsegments")
      }}</Label>
      <NumberField
        v-model="values.radialSegments"
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
        t("sidebar/geometry/tube_geometry/closed")
      }}</Label>
      <Checkbox v-model="values.closed" @update:model-value="update" />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/tube_geometry/curvetype")
      }}</Label>
      <Select
        :model-value="values.curveType"
        @update:model-value="onCurveTypeChange"
      >
        <SelectTrigger size="sm" class="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="opt in curveTypeOptions" :key="opt" :value="opt">
            {{ opt }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div v-if="showTension" class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/tube_geometry/tension")
      }}</Label>
      <NumberField
        v-model="values.tension"
        :step="0.01"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-7 text-xs" />
        </NumberFieldContent>
      </NumberField>
    </div>
  </div>
</template>
