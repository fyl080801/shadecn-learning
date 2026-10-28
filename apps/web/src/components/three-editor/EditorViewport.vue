<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { Viewport } from "./Viewport"
import type { ViewHelperOffset } from "./Viewport.ViewHelper"
import { useEditor } from "./composables/useEditorContext"

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  viewHelperOffset?: ViewHelperOffset
}>()

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

  const viewport = Viewport(editor, { viewHelperOffset: props.viewHelperOffset })
  viewport.style.position = "absolute"
  viewport.style.inset = "0"
  hostRef.value?.appendChild(viewport)

  // 监视视口自身的盒子，而非依赖移动它的任何调整器，
  // 使渲染器/相机始终保持同步，无论周围布局如何调整此元素的大小
  // （手动拖拽调整器、ResizablePanelGroup 分割、窗口调整大小等）。
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
  <div ref="hostRef" v-bind="$attrs" class="te-viewport" />
</template>
