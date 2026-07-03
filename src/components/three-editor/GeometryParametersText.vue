<script setup lang="ts">
// @ts-nocheck
import { reactive, watch } from "vue"
import { TextGeometry } from "three/addons/geometries/TextGeometry.js"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"

import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
  text: "",
  size: 1,
  depth: 1,
  curveSegments: 12,
  bevelEnabled: false,
  bevelThickness: 0.1,
  bevelSize: 0.01,
  bevelOffset: 0,
  bevelSegments: 3
})

function refresh() {
  const options = props.object?.geometry?.parameters?.options
  if (!options) return

  values.text = options.text
  values.size = options.size
  values.depth = options.depth
  values.curveSegments = options.curveSegments
  values.bevelEnabled = options.bevelEnabled
  values.bevelThickness = options.bevelThickness
  values.bevelSize = options.bevelSize
  values.bevelOffset = options.bevelOffset
  values.bevelSegments = options.bevelSegments
}

function update() {
  const object = props.object
  const parameters = object?.geometry?.parameters?.options
  if (!parameters) return

  const options = {
    text: values.text,
    font: parameters.font,
    size: values.size,
    depth: values.depth,
    curveSegments: values.curveSegments,
    bevelEnabled: values.bevelEnabled,
    bevelThickness: values.bevelThickness,
    bevelSize: values.bevelSize,
    bevelOffset: values.bevelOffset,
    bevelSegments: values.bevelSegments
  }

  editor.execute(
    new SetGeometryCommand(
      editor,
      object,
      new TextGeometry(options.text, options)
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
        t("sidebar/geometry/text_geometry/text")
      }}</Label>
      <Input
        v-model="values.text"
        class="h-7 w-[150px] text-xs"
        @change="update"
      />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/text_geometry/size")
      }}</Label>
      <NumberField
        v-model="values.size"
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
        t("sidebar/geometry/text_geometry/depth")
      }}</Label>
      <NumberField
        v-model="values.depth"
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
        t("sidebar/geometry/text_geometry/curveseg")
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
        t("sidebar/geometry/text_geometry/bevelenabled")
      }}</Label>
      <Checkbox v-model="values.bevelEnabled" @update:model-value="update" />
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/text_geometry/bevelthickness")
      }}</Label>
      <NumberField
        v-model="values.bevelThickness"
        :min="0"
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
        t("sidebar/geometry/text_geometry/bevelsize")
      }}</Label>
      <NumberField
        v-model="values.bevelSize"
        :min="0"
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
        t("sidebar/geometry/text_geometry/bevelOffset")
      }}</Label>
      <NumberField
        v-model="values.bevelOffset"
        :min="0"
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
        t("sidebar/geometry/text_geometry/bevelseg")
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
  </div>
</template>
