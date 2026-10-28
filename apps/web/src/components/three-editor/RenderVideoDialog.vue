<script setup lang="ts">
import { ref } from "vue"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

import { APP } from "./libs/app"
import { createMP4, formatFileSize } from "./libs/mp4Mux"

const props = defineProps<{
  open: boolean
  editor: any
  strings: any
}>()

const emit = defineEmits<{
  (e: "update:open", value: boolean): void
}>()

function t(key: string) {
  return props.strings.getKey(key)
}

const qualityOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "ultra", label: "Ultra" }
]

const qualityToBitrate: Record<string, number> = {
  low: 2e6,
  medium: 5e6,
  high: 10e6,
  ultra: 20e6
}

const videoWidth = ref(1024)
const videoHeight = ref(1024)
const videoFPS = ref(30)
const videoDuration = ref(10)
const videoQuality = ref("high")

function toDiv2(value: number) {
  return 2 * Math.floor(value / 2)
}

function onWidthChange(value: number) {
  videoWidth.value = toDiv2(value)
}

function onHeightChange(value: number) {
  videoHeight.value = toDiv2(value)
}

function close() {
  emit("update:open", false)
}

async function onRender() {
  const editor = props.editor

  const player = new (APP as any).Player()
  await player.load(editor.toJSON())
  player.setPixelRatio(1)
  player.setSize(videoWidth.value, videoHeight.value)
  player.setClearColor(editor.viewportColor)

  const width = videoWidth.value / window.devicePixelRatio
  const height = videoHeight.value / window.devicePixelRatio

  const canvas = player.canvas
  canvas.style.width = width + "px"
  canvas.style.height = height + "px"

  const left = (screen.width - width) / 2
  const top = (screen.height - height) / 2

  const output = window.open(
    "",
    "_blank",
    `location=no,left=${left},top=${top},width=${width},height=${height}`
  )!

  const meta = document.createElement("meta")
  meta.name = "viewport"
  meta.content =
    "width=device-width, user-scalable=no, minimum-scale=1.0, maximum-scale=1.0"
  output.document.head.appendChild(meta)

  output.document.body.style.background = "#000"
  output.document.body.style.margin = "0px"
  output.document.body.style.overflow = "hidden"
  output.document.body.appendChild(canvas)

  const status = document.createElement("div")
  status.style.position = "absolute"
  status.style.top = "10px"
  status.style.left = "10px"
  status.style.color = "white"
  status.style.fontFamily = "system-ui"
  status.style.fontSize = "12px"
  status.style.textShadow = "0 0 2px black"
  output.document.body.appendChild(status)

  const video = document.createElement("video")
  video.width = width
  video.height = height
  video.controls = true
  video.loop = true
  video.hidden = true
  output.document.body.appendChild(video)

  output.addEventListener("unload", function () {
    if (video.src.startsWith("blob:")) {
      URL.revokeObjectURL(video.src)
    }
  })

  const fps = videoFPS.value
  const duration = videoDuration.value
  const frames = duration * fps

  const encodedChunks: { data: Uint8Array; timestamp: number; type: string }[] =
    []
  let codecConfig: Uint8Array | null = null

  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description) {
        codecConfig = new Uint8Array(
          metadata.decoderConfig.description as ArrayBuffer
        )
      }

      const chunkData = new Uint8Array(chunk.byteLength)
      chunk.copyTo(chunkData)
      encodedChunks.push({
        data: chunkData,
        timestamp: chunk.timestamp,
        type: chunk.type
      })
    },
    error: (e) => console.error("VideoEncoder error:", e)
  })

  videoEncoder.configure({
    codec: "avc1.640028",
    width: videoWidth.value,
    height: videoHeight.value,
    bitrate: qualityToBitrate[videoQuality.value],
    framerate: fps,
    avc: { format: "avc" }
  })

  let currentTime = 0
  let aborted = false

  for (let i = 0; i < frames; i++) {
    if (output.closed) {
      aborted = true
      break
    }

    player.render(currentTime)

    const bitmap = await createImageBitmap(canvas)
    const frame = new VideoFrame(bitmap, { timestamp: i * (1e6 / fps) })

    videoEncoder.encode(frame, { keyFrame: i % fps === 0 })
    frame.close()
    bitmap.close()

    currentTime += 1 / fps

    const progress = Math.floor(((i + 1) / frames) * 100)
    status.textContent = `${i + 1} / ${frames} ( ${progress}% )`
  }

  if (!aborted) {
    await videoEncoder.flush()
    videoEncoder.close()

    output.document.body.removeChild(canvas)

    const mp4Data = createMP4(
      encodedChunks,
      codecConfig!,
      videoWidth.value,
      videoHeight.value,
      fps
    )

    status.textContent = `${frames} / ${frames} ( 100% ) ${formatFileSize(mp4Data.byteLength)} ✓`

    video.src = URL.createObjectURL(
      new Blob([mp4Data as BlobPart], { type: "video/mp4" })
    )
    video.hidden = false
  }

  player.dispose()

  close()
}
</script>

<template>
  <Dialog :open="open" @update:open="close">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {{ t("menubar/render") }} {{ t("menubar/render/video") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/resolution")
        }}</Label>
        <NumberField
          :model-value="videoWidth"
          :step="2"
          class="w-20"
          @update:model-value="onWidthChange"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <span class="text-xs">&times;</span>
        <NumberField
          :model-value="videoHeight"
          :step="2"
          class="w-20"
          @update:model-value="onHeightChange"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <NumberField v-model="videoFPS" class="w-16">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <span class="text-xs">fps</span>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/duration")
        }}</Label>
        <NumberField v-model="videoDuration" class="w-20">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("menubar/render/quality")
        }}</Label>
        <Select v-model="videoQuality">
          <SelectTrigger size="sm" class="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in qualityOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="close">
          {{ t("menubar/render/cancel") }}
        </Button>
        <Button @click="onRender">
          {{ t("sidebar/project/render") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
