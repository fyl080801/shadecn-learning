<script setup lang="ts">
import { useEditor } from "./composables/useEditorContext"

const SIDEBAR_MIN_WIDTH = 335
const SIDEBAR_DEFAULT_WIDTH = 350

const props = defineProps<{ sidebarColRef: HTMLDivElement | null }>()

const editor = useEditor()

let sidebarWidth = SIDEBAR_DEFAULT_WIDTH

function onPointerMove(event: PointerEvent) {
  if (event.isPrimary === false) return
  if (!props.sidebarColRef) return

  const offsetWidth = document.body.offsetWidth
  const clientX = event.clientX
  const cX = clientX < 0 ? 0 : clientX > offsetWidth ? offsetWidth : clientX

  sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, offsetWidth - cX)
  props.sidebarColRef.style.width = sidebarWidth + "px"

  editor.signals.windowResize.dispatch()
}

function onPointerUp(event: PointerEvent) {
  if (event.isPrimary === false) return
  document.removeEventListener("pointermove", onPointerMove)
  document.removeEventListener("pointerup", onPointerUp)
}

function onPointerDown(event: PointerEvent) {
  if (event.isPrimary === false) return
  document.addEventListener("pointermove", onPointerMove)
  document.addEventListener("pointerup", onPointerUp)
}
</script>

<template>
  <div
    class="w-1.25 shrink-0 cursor-col-resize hover:bg-sky-400/50 active:bg-sky-400"
    @pointerdown="onPointerDown"
  />
</template>
