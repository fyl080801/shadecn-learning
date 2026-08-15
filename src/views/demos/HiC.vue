<script setup lang="ts">
import { onMounted, ref } from "vue"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"

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
    <canvas ref="canvasRef" class="w-full h-full" layoutsubtree>
      <div ref="formElRef">
        <form>
          <label for="name">name:</label>
          <input id="name" />
        </form>
        <div class="w-100 flex flex-col">
          <div>aaa</div>
          <div>bbb</div>
        </div>

        <div class="flex flex-col items-center justify-center p-8">
          <Card class="w-full max-w-2xl">
            <CardHeader>
              <CardTitle class="text-2xl">About</CardTitle>
              <CardDescription> Learn more about this project </CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              <p class="text-muted-foreground">
                This is a Vue.js application built with Vite and shadcn-vue
                components.
              </p>
              <p class="text-muted-foreground">
                It demonstrates the use of modern Vue 3 features including the
                Composition API, TypeScript support, and a beautiful UI
                component library.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </canvas>
  </div>
</template>
