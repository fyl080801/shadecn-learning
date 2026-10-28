<script setup lang="ts">
import { ref, watch } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"

import { Label } from "@/components/ui/label"
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

const curveSegments = ref(12)

function refresh() {
  const parameters = props.object?.geometry?.parameters
  if (!parameters) return
  curveSegments.value = parameters.curveSegments ?? 12
}

function update() {
  const object = props.object
  const parameters = object?.geometry?.parameters
  if (!parameters) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.ShapeGeometry(parameters.shapes, curveSegments.value)
    )
  )
}

function toExtrude() {
  const object = props.object
  const parameters = object?.geometry?.parameters
  if (!parameters) return

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new THREE.ExtrudeGeometry(parameters.shapes, {
        curveSegments: curveSegments.value
      })
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
        t("sidebar/geometry/shape_geometry/curveSegments")
      }}</Label>
      <NumberField
        v-model="curveSegments"
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

    <Button size="sm" variant="outline" class="text-xs" @click="toExtrude">
      {{ t("sidebar/geometry/shape_geometry/extrude") }}
    </Button>
  </div>
</template>
