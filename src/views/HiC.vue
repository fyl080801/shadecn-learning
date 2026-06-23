<script setup lang="ts">
import { onMounted, ref } from "vue"

const canvasRef = ref<HTMLCanvasElement>()

const formElRef = ref<HTMLFormElement>()

onMounted(() => {
  if (!canvasRef.value) return

  const ctx = canvasRef.value.getContext("2d")

  canvasRef.value?.addEventListener("paint", () => {
    ctx?.reset()

    if (!formElRef.value) return

    const transform = ctx?.drawElementImage(formElRef.value, 0, 0)

    if (transform) formElRef.value.style.transform = transform.toString()
  })

  const observer = new ResizeObserver(([entry]) => {
    if (!canvasRef.value) return
    if (!entry || !entry.devicePixelContentBoxSize[0]) return

    canvasRef.value.width = entry.devicePixelContentBoxSize[0].inlineSize
    canvasRef.value.height = entry.devicePixelContentBoxSize[0].blockSize
  })

  observer.observe(canvasRef.value, { box: "device-pixel-content-box" })
})
</script>

<template>
  <div>
    <canvas ref="canvasRef" class="w-100 h-50" layoutsubtree>
      <div ref="formElRef">
        <form>
          <label for="name">name:</label>
          <input id="name" />
        </form>
        <div class="w-100 flex flex-col">
          <div>aaa</div>
          <div>bbb</div>
        </div>
      </div>
    </canvas>
  </div>
</template>
