<script setup lang="ts">
import { useEditor } from "./composables/useEditorContext"

const ANIMATION_MIN_HEIGHT = 36

const editor = useEditor()

let animationPanelHeight = ANIMATION_MIN_HEIGHT
let animationStartY = 0
let animationStartHeight = 0

function onPointerMove(event: PointerEvent) {
  if (event.isPrimary === false) return

  const deltaY = animationStartY - event.clientY
  const newHeight = animationStartHeight + deltaY
  const maxHeight = window.innerHeight / 2

  animationPanelHeight = Math.max(
    ANIMATION_MIN_HEIGHT,
    Math.min(maxHeight, newHeight)
  )

  editor.signals.animationPanelResized.dispatch(animationPanelHeight)
}

function onPointerUp(event: PointerEvent) {
  if (event.isPrimary === false) return
  document.removeEventListener("pointermove", onPointerMove)
  document.removeEventListener("pointerup", onPointerUp)
}

function onPointerDown(event: PointerEvent) {
  if (event.isPrimary === false) return
  animationStartY = event.clientY
  animationStartHeight = animationPanelHeight
  document.addEventListener("pointermove", onPointerMove)
  document.addEventListener("pointerup", onPointerUp)
}
</script>

<template>
  <div
    class="h-1.25 shrink-0 cursor-row-resize hover:bg-sky-400/50 active:bg-sky-400"
    @pointerdown="onPointerDown"
  />
</template>
