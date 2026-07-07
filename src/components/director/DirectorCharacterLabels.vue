<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { showCharacterLabels } from "./directorState"

const editor = useEditor()

const containerRef = ref<HTMLDivElement | null>(null)
const labels = ref<
  Array<{ uuid: string; name: string; left: number; top: number }>
>([])

const projected = new THREE.Vector3()
let rafId = 0

function tick() {
  rafId = requestAnimationFrame(tick)

  const container = containerRef.value
  if (!container || !showCharacterLabels.value) {
    if (labels.value.length) labels.value = []
    return
  }

  const rect = container.getBoundingClientRect()
  const camera = editor.viewportCamera

  const next: typeof labels.value = []

  for (const object of editor.scene.children) {
    if (!object.userData?.isCharacter || !object.visible) continue

    object.getWorldPosition(projected)
    projected.y += 1.9 // 浮在角色头顶上方
    projected.project(camera)

    if (projected.z > 1) continue

    next.push({
      uuid: object.uuid,
      name: object.name,
      left: ((projected.x + 1) / 2) * rect.width,
      top: ((1 - projected.y) / 2) * rect.height
    })
  }

  labels.value = next
}

onMounted(() => {
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
})
</script>

<template>
  <div
    ref="containerRef"
    class="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <div
      v-for="label in labels"
      :key="label.uuid"
      class="absolute -translate-x-1/2 -translate-y-full rounded bg-black/70 px-2 py-0.5 text-xs text-white"
      :style="{ left: `${label.left}px`, top: `${label.top}px` }"
    >
      {{ label.name }}
    </div>
  </div>
</template>
