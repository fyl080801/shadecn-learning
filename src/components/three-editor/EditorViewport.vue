<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { Viewport } from "./Viewport"
import { useEditor } from "./composables/useEditorContext"

const editor = useEditor()
const signals = editor.signals

const hostRef = ref<HTMLDivElement | null>(null)

let renderer: THREE.WebGLRenderer | undefined

function onRendererCreated(newRenderer: THREE.WebGLRenderer) {
  renderer = newRenderer
}

onMounted(() => {
  signals.rendererCreated.add(onRendererCreated)

  const viewport = new Viewport(editor)
  viewport.dom.style.position = "absolute"
  viewport.dom.style.inset = "0"
  hostRef.value?.appendChild(viewport.dom)
})

onBeforeUnmount(() => {
  signals.rendererCreated.remove(onRendererCreated)

  if (renderer) {
    renderer.setAnimationLoop(null)
    renderer.dispose()
  }
})
</script>

<template>
  <div ref="hostRef" class="te-viewport absolute inset-0" />
</template>
