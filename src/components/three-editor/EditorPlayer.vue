<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"

import { APP } from "./libs/app"
import { useEditor } from "./composables/useEditorContext"

const editor = useEditor()
const signals = editor.signals

const containerRef = ref<HTMLDivElement | null>(null)
const visible = ref(false)

let player: any = null

function resize() {
  if (!player || !containerRef.value) return
  player.setSize(containerRef.value.clientWidth, containerRef.value.clientHeight)
}

function onStartPlayer() {
  visible.value = true
  player.load(editor.toJSON()).then(() => {
    resize()
    player.play()
  })
}

function onStopPlayer() {
  visible.value = false
  player.stop()
  player.dispose()
}

function onWindowResize() {
  resize()
}

onMounted(() => {
  player = new APP.Player()
  containerRef.value?.appendChild(player.dom)

  window.addEventListener("resize", onWindowResize)
  signals.windowResize.add(onWindowResize)
  signals.startPlayer.add(onStartPlayer)
  signals.stopPlayer.add(onStopPlayer)
})

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize)
  signals.windowResize.remove(onWindowResize)
  signals.startPlayer.remove(onStartPlayer)
  signals.stopPlayer.remove(onStopPlayer)
})
</script>

<template>
  <div v-show="visible" ref="containerRef" class="absolute inset-0" />
</template>
