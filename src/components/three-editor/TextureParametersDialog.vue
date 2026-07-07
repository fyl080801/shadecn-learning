<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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

import { renderToCanvas } from "./libs/textureRender"

const props = defineProps<{
  open: boolean
  editor: any
  texture: any
}>()

const emit = defineEmits<{
  (e: "update:open", value: boolean): void
  (e: "confirm", parameters: any): void
  (e: "cancel"): void
}>()

function t(key: string) {
  return props.editor.strings.getKey(key)
}

const mappingOptions = [
  { value: String(THREE.UVMapping), label: "UV" },
  {
    value: String(THREE.EquirectangularReflectionMapping),
    label: "Equirectangular Reflection"
  },
  {
    value: String(THREE.EquirectangularRefractionMapping),
    label: "Equirectangular Refraction"
  },
  { value: String(THREE.CubeReflectionMapping), label: "Cube Reflection" },
  { value: String(THREE.CubeRefractionMapping), label: "Cube Refraction" },
  { value: String(THREE.CubeUVReflectionMapping), label: "CubeUV Reflection" }
]

const wrapOptions = [
  { value: String(THREE.RepeatWrapping), label: "Repeat" },
  { value: String(THREE.ClampToEdgeWrapping), label: "Clamp To Edge" },
  { value: String(THREE.MirroredRepeatWrapping), label: "Mirrored Repeat" }
]

const minFilterOptions = [
  { value: String(THREE.NearestFilter), label: "Nearest" },
  {
    value: String(THREE.NearestMipmapNearestFilter),
    label: "Nearest Mipmap Nearest"
  },
  {
    value: String(THREE.NearestMipmapLinearFilter),
    label: "Nearest Mipmap Linear"
  },
  { value: String(THREE.LinearFilter), label: "Linear" },
  {
    value: String(THREE.LinearMipmapNearestFilter),
    label: "Linear Mipmap Nearest"
  },
  {
    value: String(THREE.LinearMipmapLinearFilter),
    label: "Linear Mipmap Linear"
  }
]

const magFilterOptions = [
  { value: String(THREE.NearestFilter), label: "Nearest" },
  { value: String(THREE.LinearFilter), label: "Linear" }
]

// reka-ui 的 Select 将空字符串保留为"无值"哨兵，但
// THREE.NoColorSpace 的值*就是* "" —— 因此这里需要一个非空的替代值。
const COLOR_SPACE_NONE = "none"

const colorSpaceOptions = [
  { value: COLOR_SPACE_NONE, label: "No Color Space" },
  { value: THREE.SRGBColorSpace, label: "sRGB" },
  { value: THREE.LinearSRGBColorSpace, label: "Linear sRGB" }
]

const texture = props.texture

const mapping = ref(String(texture.mapping))
const wrapS = ref(String(texture.wrapS))
const wrapT = ref(String(texture.wrapT))
const minFilter = ref(String(texture.minFilter))
const magFilter = ref(String(texture.magFilter))
const anisotropy = ref(texture.anisotropy)
const offsetX = ref(texture.offset.x)
const offsetY = ref(texture.offset.y)
const repeatX = ref(texture.repeat.x)
const repeatY = ref(texture.repeat.y)
const centerX = ref(texture.center.x)
const centerY = ref(texture.center.y)
const rotation = ref(texture.rotation * THREE.MathUtils.RAD2DEG)
const premultiplyAlpha = ref(texture.premultiplyAlpha)
const colorSpace = ref(
  texture.colorSpace === THREE.NoColorSpace ? COLOR_SPACE_NONE : texture.colorSpace
)

const previewCanvas = ref<HTMLCanvasElement | null>(null)
let previewTexture: THREE.Texture

function getCurrentParameters() {
  return {
    mapping: parseInt(mapping.value),
    wrapS: parseInt(wrapS.value),
    wrapT: parseInt(wrapT.value),
    magFilter: parseInt(magFilter.value),
    minFilter: parseInt(minFilter.value),
    anisotropy: anisotropy.value,
    offset: { x: offsetX.value, y: offsetY.value },
    repeat: { x: repeatX.value, y: repeatY.value },
    center: { x: centerX.value, y: centerY.value },
    rotation: rotation.value * THREE.MathUtils.DEG2RAD,
    premultiplyAlpha: premultiplyAlpha.value,
    colorSpace:
      colorSpace.value === COLOR_SPACE_NONE ? THREE.NoColorSpace : colorSpace.value
  }
}

function applyParameters(target: THREE.Texture, p: ReturnType<typeof getCurrentParameters>) {
  target.mapping = p.mapping as THREE.Mapping
  target.wrapS = p.wrapS as THREE.Wrapping
  target.wrapT = p.wrapT as THREE.Wrapping
  target.magFilter = p.magFilter as THREE.MagnificationTextureFilter
  target.minFilter = p.minFilter as THREE.MinificationTextureFilter
  target.anisotropy = p.anisotropy
  target.offset.set(p.offset.x, p.offset.y)
  target.repeat.set(p.repeat.x, p.repeat.y)
  target.center.set(p.center.x, p.center.y)
  target.rotation = p.rotation
  target.premultiplyAlpha = p.premultiplyAlpha
  target.colorSpace = p.colorSpace
  target.needsUpdate = true
}

function updatePreview() {
  applyParameters(previewTexture, getCurrentParameters())

  const rendered = renderToCanvas(previewTexture)

  const canvas = previewCanvas.value
  const context = canvas?.getContext("2d")
  if (!canvas || !context) return

  context.clearRect(0, 0, canvas.width, canvas.height)

  if (rendered.width === 0 || rendered.height === 0) return

  const scale = Math.min(canvas.width / rendered.width, canvas.height / rendered.height)
  const w = rendered.width * scale
  const h = rendered.height * scale
  context.drawImage(rendered, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
}

function onOpenChange(value: boolean) {
  emit("update:open", value)
  if (!value) {
    previewTexture?.dispose()
    emit("cancel")
  }
}

function onConfirm() {
  const result = getCurrentParameters()
  previewTexture?.dispose()
  emit("confirm", result)
}

onMounted(() => {
  previewTexture = texture.clone()
  updatePreview()
})

onBeforeUnmount(() => {
  previewTexture?.dispose()
})
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ t("dialog/texture/title") }}</DialogTitle>
      </DialogHeader>

      <div class="grid grid-cols-[auto_1fr] gap-4">
        <div class="flex flex-col gap-2">
          <div class="text-xs font-medium">
            {{ t("dialog/texture/group/preview") }}
          </div>
          <canvas ref="previewCanvas" width="200" height="200" class="border" />
        </div>

        <div class="flex flex-col gap-2 text-xs">
          <div class="font-medium">{{ t("dialog/texture/group/mapping") }}</div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/mapping") }}</Label>
            <Select v-model="mapping" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in mappingOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/wrapS") }}</Label>
            <Select v-model="wrapS" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in wrapOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/wrapT") }}</Label>
            <Select v-model="wrapT" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in wrapOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="mt-2 font-medium">{{ t("dialog/texture/group/filtering") }}</div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/minFilter") }}</Label>
            <Select v-model="minFilter" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in minFilterOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/magFilter") }}</Label>
            <Select v-model="magFilter" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in magFilterOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/anisotropy") }}</Label>
            <NumberField v-model="anisotropy" :min="1" :max="16" :step="1" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
          </div>

          <div class="mt-2 font-medium">{{ t("dialog/texture/group/transform") }}</div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/offset") }}</Label>
            <NumberField v-model="offsetX" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
            <NumberField v-model="offsetY" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/repeat") }}</Label>
            <NumberField v-model="repeatX" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
            <NumberField v-model="repeatY" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/center") }}</Label>
            <NumberField v-model="centerX" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
            <NumberField v-model="centerY" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/rotation") }}</Label>
            <NumberField v-model="rotation" :step="10" class="w-20" @update:model-value="updatePreview">
              <NumberFieldContent>
                <NumberFieldInput class="h-7 text-xs" />
              </NumberFieldContent>
            </NumberField>
          </div>

          <div class="mt-2 font-medium">{{ t("dialog/texture/group/color") }}</div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/premultiplyAlpha") }}</Label>
            <Checkbox v-model="premultiplyAlpha" @update:model-value="updatePreview" />
          </div>

          <div class="flex items-center gap-2">
            <Label class="w-24 shrink-0 text-xs">{{ t("dialog/texture/colorSpace") }}</Label>
            <Select v-model="colorSpace" @update:model-value="updatePreview">
              <SelectTrigger size="sm" class="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in colorSpaceOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="onOpenChange(false)">{{ t("dialog/cancel") }}</Button>
        <Button @click="onConfirm">{{ t("dialog/ok") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
