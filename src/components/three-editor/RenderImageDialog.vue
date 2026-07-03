<script setup lang="ts">
import { computed, ref } from "vue"
import * as THREE from "three"

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

import { ViewportPathtracer } from "./Viewport.Pathtracer"

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

const shadingOptions = [
  { value: "solid", label: "SOLID" },
  { value: "realistic", label: "REALISTIC" }
]

const shadingType = ref("solid")
const showSamples = computed(() => shadingType.value === "realistic")

const pathTracerMinSamples = 3
const pathTracerMaxSamples = 65536
const samples = ref(16)

const imageWidth = ref(1024)
const imageHeight = ref(1024)

function close() {
  emit("update:open", false)
}

async function onRender() {
  const editor = props.editor

  if (shadingType.value === "realistic") {
    let isMaterialsValid: boolean = true

    editor.scene.traverseVisible((object: any) => {
      if (object.isMesh) {
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material]

        for (let i = 0; i < materials.length; i++) {
          const material = materials[i]

          if (!material.isMeshStandardMaterial) {
            isMaterialsValid = false
            return
          }
        }
      }
    })

    if (!isMaterialsValid) {
      alert(
        props.strings.getKey("prompt/rendering/realistic/unsupportedMaterial")
      )
      return
    }
  }

  const json = editor.toJSON()
  const project = json.project

  const loader = new THREE.ObjectLoader()

  const camera: any = await loader.parseAsync(json.camera)

  const aspect = imageWidth.value / imageHeight.value

  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect
  } else {
    const frustumHeight = camera.top - camera.bottom

    camera.left = (-frustumHeight * aspect) / 2
    camera.right = (frustumHeight * aspect) / 2
  }

  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()

  const scene = await loader.parseAsync(json.scene)

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    reversedDepthBuffer: true
  })
  renderer.setSize(imageWidth.value, imageHeight.value)
  renderer.setClearColor(editor.viewportColor)

  if (project.shadows !== undefined)
    renderer.shadowMap.enabled = project.shadows
  if (project.shadowType !== undefined)
    renderer.shadowMap.type = project.shadowType
  if (project.toneMapping !== undefined)
    renderer.toneMapping = project.toneMapping
  if (project.toneMappingExposure !== undefined)
    renderer.toneMappingExposure = project.toneMappingExposure

  // popup

  const width = imageWidth.value / window.devicePixelRatio
  const height = imageHeight.value / window.devicePixelRatio

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

  const canvas = renderer.domElement
  canvas.style.width = width + "px"
  canvas.style.height = height + "px"
  output.document.body.appendChild(canvas)

  if (shadingType.value === "solid") {
    renderer.render(scene, camera)
    renderer.dispose()
  } else if (shadingType.value === "realistic") {
    const status = document.createElement("div")
    status.style.position = "absolute"
    status.style.top = "10px"
    status.style.left = "10px"
    status.style.color = "white"
    status.style.fontFamily = "system-ui"
    status.style.fontSize = "12px"
    output.document.body.appendChild(status)

    const pathTracer = new (ViewportPathtracer as any)(renderer)
    pathTracer.init(scene, camera)
    pathTracer.setSize(imageWidth.value, imageHeight.value)

    const maxSamples = Math.max(
      pathTracerMinSamples,
      Math.min(pathTracerMaxSamples, samples.value)
    )

    function animate() {
      if (output.closed === true) return

      const currentSamples = Math.floor(pathTracer.getSamples()) + 1

      if (currentSamples < maxSamples) {
        requestAnimationFrame(animate)
      }

      pathTracer.update()

      const progress = Math.floor((currentSamples / maxSamples) * 100)

      status.textContent = `${currentSamples} / ${maxSamples} ( ${progress}% )`

      if (progress === 100) {
        status.textContent += " ✓"
      }
    }

    animate()
  }

  close()
}
</script>

<template>
  <Dialog :open="open" @update:open="close">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {{ t("menubar/render") }} {{ t("menubar/render/image") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/shading")
        }}</Label>
        <Select v-model="shadingType">
          <SelectTrigger size="sm" class="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in shadingOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div v-if="showSamples" class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/image/samples")
        }}</Label>
        <NumberField
          v-model="samples"
          :min="pathTracerMinSamples"
          :max="pathTracerMaxSamples"
          class="w-24"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/resolution")
        }}</Label>
        <NumberField v-model="imageWidth" class="w-20">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
        <span class="text-xs">&times;</span>
        <NumberField v-model="imageHeight" class="w-20">
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
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
