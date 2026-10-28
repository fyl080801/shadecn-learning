<script setup lang="ts">
import { ref, watch } from "vue"

import { loadTextureFile } from "./libs/textureLoader"
import { renderToCanvas } from "./libs/textureRender"

const props = defineProps<{
  modelValue: any
  editor: any
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: any): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const isDragOver = ref(false)

function draw() {
  const canvas = canvasRef.value
  const context = canvas?.getContext("2d")
  if (!canvas || !context) return

  // 始终先清除，因为传入的纹理可能包含透明度。
  context.clearRect(0, 0, canvas.width, canvas.height)

  const texture = props.modelValue
  if (!texture) {
    canvas.title = "empty"
    return
  }

  const image = texture.image

  if (image !== undefined && image !== null && image.width > 0) {
    canvas.title = texture.sourceFile ?? ""
    const scale = canvas.width / image.width

    if (texture.isDataTexture || texture.isCompressedTexture) {
      const rendered = renderToCanvas(texture)
      context.drawImage(
        rendered,
        0,
        0,
        image.width * scale,
        image.height * scale
      )
    } else {
      context.drawImage(image, 0, 0, image.width * scale, image.height * scale)
    }
  } else {
    canvas.title = `${texture.sourceFile ?? ""} (error)`
  }
}

watch(() => props.modelValue, draw, { immediate: true })

async function loadFile(file: File | null | undefined) {
  if (!file) return

  try {
    const texture = await loadTextureFile(file, props.editor)
    emit("update:modelValue", texture)
  } finally {
    if (inputRef.value) inputRef.value.value = ""
  }
}

function onInputChange(event: Event) {
  const target = event.target as HTMLInputElement
  loadFile(target.files?.[0])
}

function onDrop(event: DragEvent) {
  isDragOver.value = false
  loadFile(event.dataTransfer?.files?.[0])
}
</script>

<template>
  <div class="inline-block">
    <input
      ref="inputRef"
      type="file"
      class="hidden"
      accept="image/*,.hdr,.pic,.tga,.ktx2,.exr"
      @change="onInputChange"
    />
    <canvas
      ref="canvasRef"
      width="32"
      height="16"
      class="cursor-pointer border border-input"
      :class="{ 'ring-2 ring-ring': isDragOver }"
      @click="inputRef?.click()"
      @dragover.prevent="isDragOver = true"
      @dragleave.prevent="isDragOver = false"
      @drop.prevent="onDrop"
    />
  </div>
</template>
