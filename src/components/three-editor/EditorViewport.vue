<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { Viewport } from "./Viewport"
import { useEditor } from "./composables/useEditorContext"
import ViewportControlsOverlay from "./ViewportControlsOverlay.vue"
import ViewportInfoOverlay from "./ViewportInfoOverlay.vue"

defineOptions({ inheritAttrs: false })

const editor = useEditor()
const signals = editor.signals

const hostRef = ref<HTMLDivElement | null>(null)

let renderer: THREE.WebGLRenderer | undefined
let resizeObserver: ResizeObserver | undefined

function onRendererCreated(newRenderer: THREE.WebGLRenderer) {
  renderer = newRenderer
}

onMounted(() => {
  signals.rendererCreated.add(onRendererCreated)

  const viewport = new Viewport(editor)
  viewport.style.position = "absolute"
  viewport.style.inset = "0"
  hostRef.value?.appendChild(viewport)

  // Watches the viewport's own box instead of relying on whatever resizer
  // moved it, so the renderer/camera stay in sync no matter how the
  // surrounding layout resizes this element (manual drag resizer, a
  // ResizablePanelGroup split, a window resize, etc).
  resizeObserver = new ResizeObserver(() => {
    signals.windowResize.dispatch()
  })
  if (hostRef.value) resizeObserver.observe(hostRef.value)
})

onBeforeUnmount(() => {
  signals.rendererCreated.remove(onRendererCreated)
  resizeObserver?.disconnect()

  if (renderer) {
    renderer.setAnimationLoop(null)
    renderer.dispose()
  }
})
</script>

<template>
  <div ref="hostRef" v-bind="$attrs" class="te-viewport">
    <ViewportControlsOverlay :editor="editor" />
    <ViewportInfoOverlay :editor="editor" />
  </div>
</template>
