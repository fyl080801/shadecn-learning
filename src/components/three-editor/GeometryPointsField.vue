<script setup lang="ts">
import { X } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"

type Point = { x: number; y: number; z?: number }

const props = withDefaults(
  defineProps<{
    modelValue: Point[]
    dimension?: 2 | 3
  }>(),
  { dimension: 2 }
)

const emit = defineEmits<{
  "update:modelValue": [value: Point[]]
}>()

function addPoint() {
  const points = props.modelValue
  const last = points[points.length - 1]
  const point: Point = { x: last?.x ?? 0, y: last?.y ?? 0 }
  if (props.dimension === 3) point.z = last?.z ?? 0

  emit("update:modelValue", [...points, point])
}

function removePoint(index: number) {
  const points = props.modelValue.slice()
  points.splice(index, 1)
  emit("update:modelValue", points)
}

function updatePoint(index: number, key: "x" | "y" | "z", value: number) {
  emit(
    "update:modelValue",
    props.modelValue.map((p, i) => (i === index ? { ...p, [key]: value } : p))
  )
}
</script>

<template>
  <div class="space-y-1">
    <div
      v-for="(point, index) in modelValue"
      :key="index"
      class="flex items-center gap-1"
    >
      <span class="w-5 shrink-0 text-xs text-muted-foreground">{{
        index + 1
      }}</span>
      <NumberField
        :model-value="point.x"
        class="w-16"
        @update:model-value="(v) => updatePoint(index, 'x', v as number)"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-6 text-xs" />
        </NumberFieldContent>
      </NumberField>
      <NumberField
        :model-value="point.y"
        class="w-16"
        @update:model-value="(v) => updatePoint(index, 'y', v as number)"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-6 text-xs" />
        </NumberFieldContent>
      </NumberField>
      <NumberField
        v-if="dimension === 3"
        :model-value="point.z"
        class="w-16"
        @update:model-value="(v) => updatePoint(index, 'z', v as number)"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-6 text-xs" />
        </NumberFieldContent>
      </NumberField>
      <Button
        size="icon-sm"
        variant="ghost"
        class="h-6 w-6"
        @click="removePoint(index)"
      >
        <X class="size-3" />
      </Button>
    </div>
    <Button size="sm" variant="outline" class="h-6 text-xs" @click="addPoint">
      +
    </Button>
  </div>
</template>
