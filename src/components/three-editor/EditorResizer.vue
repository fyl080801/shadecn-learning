<script setup lang="ts">
import { useEditor } from "./composables/useEditorContext"

const ANIMATION_MIN_HEIGHT = 45
const SIDEBAR_MIN_WIDTH = 335
const SIDEBAR_DEFAULT_WIDTH = 350

const props = defineProps<{
  direction: "horizontal" | "vertical"
  sidebarColRef?: HTMLDivElement | null
}>()

const editor = useEditor()

let animationPanelHeight = ANIMATION_MIN_HEIGHT
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH
let startY = 0
let startHeight = 0

function onPointerMove(event: PointerEvent) {
  if (event.isPrimary === false) return

  if (props.direction === "vertical") {
    const deltaY = startY - event.clientY
    const newHeight = startHeight + deltaY
    const maxHeight = window.innerHeight / 2

    animationPanelHeight = Math.max(
      ANIMATION_MIN_HEIGHT,
      Math.min(maxHeight, newHeight)
    )

    editor.signals.animationPanelResized.dispatch(animationPanelHeight)
    return
  }

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
  startY = event.clientY
  startHeight = animationPanelHeight
  document.addEventListener("pointermove", onPointerMove)
  document.addEventListener("pointerup", onPointerUp)
}
</script>

<template>
  <div
    :class="[
      'te-resizer shrink-0 hover:bg-sky-400/50 active:bg-sky-400',
      direction === 'vertical'
        ? 'h-1.25 cursor-row-resize'
        : 'w-1.25 cursor-col-resize'
    ]"
    @pointerdown="onPointerDown"
  />
</template>
