<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"
import { WebGPURenderer } from "three/webgpu"
import { zipSync, strToU8 } from "three/addons/libs/fflate.module.js"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"
import { SetMaterialCommand } from "./commands/SetMaterialCommand"

import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const editor = useEditor()
const config = editor.config
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

// ===== 应用 =====

const projectTitle = ref(config.getKey("project/title"))
const projectEditable = ref(config.getKey("project/editable"))
const isPlaying = ref(false)

function onTitleChange() {
  config.setKey("project/title", projectTitle.value)
}

function onEditableChange() {
  config.setKey("project/editable", projectEditable.value)
}

function onPlayToggle() {
  isPlaying.value = !isPlaying.value

  if (isPlaying.value) {
    signals.startPlayer.dispatch()
  } else {
    signals.stopPlayer.dispatch()
  }
}

function indent(text: string, count: number, space = "\t") {
  return text
    .split("\n")
    .map((line) => space.repeat(count) + line)
    .join("\n")
}

function onPublish() {
  const toZip: Record<string, Uint8Array> = {}

  const rendererType = config.getKey("project/renderer/type")

  let output: any = editor.toJSON()
  output.metadata.type = "App"
  delete output.history

  let json = JSON.stringify(output, null, "\t")
  json = json.replace(/[\n\t]+([\d\.e\-\[\]]+)/g, "$1")

  toZip["app.json"] = strToU8(json)

  const title = config.getKey("project/title")

  const manager = new THREE.LoadingManager(function () {
    const zipped = zipSync(toZip, { level: 9 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], {
      type: "application/zip"
    })
    editor.utils.save(blob, (title !== "" ? title : "untitled") + ".zip")
  })

  const loader = new THREE.FileLoader(manager)
  loader.load(
    "js/libs/app/index.html",
    function (content: string | ArrayBuffer) {
      content = content as string

      content = content.replace("<!-- title -->", title)

      const IMPORTMAP = {
        WebGLRenderer: {
          imports: {
            three: "./js/three.module.js"
          }
        },
        WebGPURenderer: {
          imports: {
            three: "./js/three.webgpu.js",
            "three/webgpu": "./js/three.webgpu.js"
          }
        }
      }
      const importmap = JSON.stringify(
        (IMPORTMAP as any)[rendererType],
        null,
        "\t"
      )
      content = content.replace(
        "<!-- importmap -->",
        indent("\n" + indent(importmap, 1) + "\n", 2)
      )

      let editButton = ""

      if (config.getKey("project/editable")) {
        editButton = [
          "\t\t\tlet button = document.createElement( 'a' );",
          "\t\t\tbutton.href = 'https://threejs.org/editor/#file=' + location.href.split( '/' ).slice( 0, - 1 ).join( '/' ) + '/app.json';",
          "\t\t\tbutton.style.cssText = 'position: absolute; bottom: 20px; right: 20px; padding: 10px 16px; color: #fff; border: 1px solid #fff; border-radius: 20px; text-decoration: none;';",
          "\t\t\tbutton.target = '_blank';",
          "\t\t\tbutton.textContent = 'EDIT';",
          "\t\t\tdocument.body.appendChild( button );"
        ].join("\n")
      }

      content = content.replace("\t\t\t/* edit button */", editButton)

      toZip["index.html"] = strToU8(content)
    }
  )
  loader.load("js/libs/app.js", function (content: string | ArrayBuffer) {
    content = content as string

    toZip["js/app.js"] = strToU8(content)
  })
  loader.load(
    "../build/three.core.js",
    function (content: string | ArrayBuffer) {
      content = content as string

      toZip["js/three.core.js"] = strToU8(content)
    }
  )

  if (rendererType === "WebGPURenderer") {
    loader.load(
      "../build/three.webgpu.js",
      function (content: string | ArrayBuffer) {
        content = content as string

        toZip["js/three.webgpu.js"] = strToU8(content)
      }
    )
  } else {
    loader.load(
      "../build/three.module.js",
      function (content: string | ArrayBuffer) {
        content = content as string

        toZip["js/three.module.js"] = strToU8(content)
      }
    )
  }
}

function onEditorCleared() {
  projectTitle.value = ""
  config.setKey("project/title", "")
}

// ===== 渲染器 =====

const cameraType = ref(config.getKey("project/camera"))
const rendererType = ref(config.getKey("project/renderer/type"))
const antialias = ref(config.getKey("project/renderer/antialias"))
const shadows = ref(config.getKey("project/renderer/shadows"))
const shadowType = ref(String(config.getKey("project/renderer/shadowType")))
const toneMapping = ref(String(config.getKey("project/renderer/toneMapping")))
const toneMappingExposure = ref(
  config.getKey("project/renderer/toneMappingExposure")
)

const showToneMappingExposure = computed(() => toneMapping.value !== "0")

const cameraTypeOptions = [
  { value: "perspective", label: "Perspective" },
  { value: "orthographic", label: "Orthographic" }
]

const rendererTypeOptions = [
  { value: "WebGLRenderer", label: "WebGL" },
  { value: "WebGPURenderer", label: "WebGPU" }
]

const shadowTypeOptions = [
  { value: "0", label: "Basic" },
  { value: "1", label: "PCF" },
  { value: "3", label: "VSM" }
]

const toneMappingOptions = [
  { value: "0", label: "No" },
  { value: "1", label: "Linear" },
  { value: "2", label: "Reinhard" },
  { value: "3", label: "Cineon" },
  { value: "4", label: "ACESFilmic" },
  { value: "6", label: "AgX" },
  { value: "7", label: "Neutral" }
]

let currentRenderer: any = null

function onCameraTypeChange() {
  editor.setCameraType(cameraType.value)
}

function updateShadows() {
  currentRenderer.shadowMap.enabled = shadows.value
  currentRenderer.shadowMap.type = parseFloat(shadowType.value)

  signals.rendererUpdated.dispatch()
}

function updateToneMapping() {
  currentRenderer.toneMapping = parseFloat(toneMapping.value)
  currentRenderer.toneMappingExposure = toneMappingExposure.value

  signals.rendererUpdated.dispatch()
}

async function createRenderer() {
  // reversedDepthBuffer 被有意忽略：three.js 会将其应用于通过此渲染器渲染的
  // *任何*相机，包括 ViewHelper 内部的正交 gizmo 相机，这会破坏其投影矩阵
  // 并导致视口坐标轴组件的点击旋转失效。
  if (rendererType.value === "WebGPURenderer") {
    currentRenderer = new WebGPURenderer({ antialias: antialias.value })
    await currentRenderer.init()
  } else {
    currentRenderer = new THREE.WebGLRenderer({ antialias: antialias.value })
  }

  currentRenderer.shadowMap.enabled = shadows.value
  currentRenderer.shadowMap.type = parseFloat(shadowType.value)
  currentRenderer.toneMapping = parseFloat(toneMapping.value)
  currentRenderer.toneMappingExposure = toneMappingExposure.value

  signals.rendererCreated.dispatch(currentRenderer)
  signals.rendererUpdated.dispatch()
}

function onCameraResetted() {
  const type = editor.camera.isOrthographicCamera
    ? "orthographic"
    : "perspective"

  cameraType.value = type
  config.setKey("project/camera", type)
}

function onRendererEditorCleared() {
  currentRenderer.shadowMap.enabled = true
  currentRenderer.shadowMap.type = THREE.PCFShadowMap
  currentRenderer.toneMapping = THREE.NeutralToneMapping
  currentRenderer.toneMappingExposure = 1

  shadows.value = currentRenderer.shadowMap.enabled
  shadowType.value = String(currentRenderer.shadowMap.type)
  toneMapping.value = String(currentRenderer.toneMapping)
  toneMappingExposure.value = currentRenderer.toneMappingExposure

  signals.rendererUpdated.dispatch()
}

function onRendererUpdated() {
  config.setKey(
    "project/renderer/type",
    rendererType.value,
    "project/renderer/antialias",
    antialias.value,
    "project/renderer/shadows",
    shadows.value,
    "project/renderer/shadowType",
    parseFloat(shadowType.value),
    "project/renderer/toneMapping",
    parseFloat(toneMapping.value),
    "project/renderer/toneMappingExposure",
    toneMappingExposure.value
  )
}

// ===== 资源 =====

function textureType(texture: any) {
  if (texture.isCanvasTexture) return "CanvasTexture"
  if (texture.isVideoTexture) return "VideoTexture"
  if (texture.isCubeDepthTexture) return "CubeDepthTexture"
  if (texture.isDepthTexture) return "DepthTexture"
  if (texture.isCompressedArrayTexture) return "CompressedArrayTexture"
  if (texture.isCompressedCubeTexture) return "CompressedCubeTexture"
  if (texture.isCompressedTexture) return "CompressedTexture"
  if (texture.isCubeTexture) return "CubeTexture"
  if (texture.isData3DTexture) return "Data3DTexture"
  if (texture.isDataArrayTexture) return "DataArrayTexture"
  if (texture.isDataTexture) return "DataTexture"
  if (texture.isFramebufferTexture) return "FramebufferTexture"

  return "Texture"
}

const geometriesList = ref<Array<{ id: number; label: string }>>([])
const materialsList = ref<Array<{ id: number; label: string }>>([])
const texturesList = ref<Array<{ id: number; label: string }>>([])

const selectedGeometryId = ref<number | null>(null)
const selectedMaterialId = ref<number | null>(null)

function refreshGeometriesUI() {
  const geometries = Object.values(editor.geometries) as any[]
  geometriesList.value = geometries.map((g) => ({
    id: g.id,
    label: g.name || g.type
  }))
}

function refreshMaterialsUI() {
  const materials = Object.values(editor.materials) as any[]
  materialsList.value = materials.map((m) => ({
    id: m.id,
    label: m.name || m.type
  }))
}

function refreshTexturesUI() {
  const textures: any[] = []
  const texturesUsed = new Set<string>()

  const materials = Object.values(editor.materials) as any[]

  for (const material of materials) {
    for (const property in material) {
      const value = material[property]

      if (value !== null && value !== undefined && value.isTexture === true) {
        if (!texturesUsed.has(value.uuid)) {
          textures.push(value)
          texturesUsed.add(value.uuid)
        }
      }
    }
  }

  texturesList.value = textures.map((texture) => ({
    id: texture.id,
    label: texture.name || textureType(texture)
  }))
}

function refreshResourcesUI() {
  refreshGeometriesUI()
  refreshMaterialsUI()
  refreshTexturesUI()
}

let refreshResourcesTimeout: ReturnType<typeof setTimeout> | undefined

function refreshResourcesUIDelayed() {
  clearTimeout(refreshResourcesTimeout)
  refreshResourcesTimeout = setTimeout(refreshResourcesUI, 100)
}

function onResourcesObjectSelected(object: any) {
  if (object !== null) {
    selectedGeometryId.value =
      object.geometry !== undefined ? object.geometry.id : null

    if (object.material !== undefined) {
      const material = Array.isArray(object.material)
        ? object.material[0]
        : object.material
      selectedMaterialId.value = material.id
    } else {
      selectedMaterialId.value = null
    }
  } else {
    selectedGeometryId.value = null
    selectedMaterialId.value = null
  }
}

function assignGeometry() {
  const selectedObject = editor.selected

  if (
    selectedObject !== null &&
    selectedObject.geometry !== undefined &&
    selectedGeometryId.value !== null
  ) {
    const geometries = Object.values(editor.geometries) as any[]
    const geometry = geometries.find((g) => g.id === selectedGeometryId.value)

    if (geometry !== undefined) {
      editor.execute(new SetGeometryCommand(editor, selectedObject, geometry))
    }
  }
}

function assignMaterial() {
  const selectedObject = editor.selected

  if (
    selectedObject !== null &&
    selectedObject.material !== undefined &&
    selectedMaterialId.value !== null
  ) {
    const materials = Object.values(editor.materials) as any[]
    const material = materials.find((m) => m.id === selectedMaterialId.value)

    if (material !== undefined) {
      editor.execute(new SetMaterialCommand(editor, selectedObject, material))
    }
  }
}

onMounted(() => {
  signals.editorCleared.add(onEditorCleared)

  // 延迟到微任务中执行，使此处始终在*整个*初始组件树挂载完成后运行，
  // 无论侧边栏还是视口在 DOM 中先挂载。若在此处同步分发
  // rendererCreated，当侧边栏在布局中先于视口放置/挂载时会与
  // Viewport.ts 自身的挂载（它注册了设置 pmremGenerator 的监听器）产生竞态。
  queueMicrotask(createRenderer)

  signals.cameraResetted.add(onCameraResetted)
  signals.editorCleared.add(onRendererEditorCleared)
  signals.rendererUpdated.add(onRendererUpdated)

  refreshResourcesUI()
  signals.editorCleared.add(refreshResourcesUIDelayed)
  signals.sceneGraphChanged.add(refreshResourcesUIDelayed)
  signals.geometryChanged.add(refreshResourcesUIDelayed)
  signals.materialAdded.add(refreshResourcesUIDelayed)
  signals.materialChanged.add(refreshResourcesUIDelayed)
  signals.materialRemoved.add(refreshResourcesUIDelayed)
  signals.objectSelected.add(onResourcesObjectSelected)
  onResourcesObjectSelected(editor.selected)
})

onBeforeUnmount(() => {
  signals.editorCleared.remove(onEditorCleared)

  signals.cameraResetted.remove(onCameraResetted)
  signals.editorCleared.remove(onRendererEditorCleared)
  signals.rendererUpdated.remove(onRendererUpdated)

  signals.editorCleared.remove(refreshResourcesUIDelayed)
  signals.sceneGraphChanged.remove(refreshResourcesUIDelayed)
  signals.geometryChanged.remove(refreshResourcesUIDelayed)
  signals.materialAdded.remove(refreshResourcesUIDelayed)
  signals.materialChanged.remove(refreshResourcesUIDelayed)
  signals.materialRemoved.remove(refreshResourcesUIDelayed)
  signals.objectSelected.remove(onResourcesObjectSelected)
})
</script>

<template>
  <div class="te-sidebar-project space-y-4 p-3">
    <div class="space-y-2">
      <Label class="text-xs uppercase">{{ t("sidebar/project/app") }}</Label>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/app/title")
        }}</Label>
        <input
          v-model="projectTitle"
          type="text"
          class="border-input h-7 w-[150px] rounded-md border bg-transparent px-2 text-xs"
          @change="onTitleChange"
        />
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/app/editable")
        }}</Label>
        <Checkbox
          v-model="projectEditable"
          @update:model-value="onEditableChange"
        />
      </div>

      <div class="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          class="text-xs"
          @click="onPlayToggle"
        >
          {{
            isPlaying
              ? t("sidebar/project/app/stop")
              : t("sidebar/project/app/play")
          }}
        </Button>
        <Button size="sm" variant="outline" class="text-xs" @click="onPublish">
          {{ t("sidebar/project/app/publish") }}
        </Button>
      </div>
    </div>

    <div class="space-y-2 border-t pt-3">
      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/camera")
        }}</Label>
        <Select v-model="cameraType" @update:model-value="onCameraTypeChange">
          <SelectTrigger size="sm" class="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in cameraTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/renderer")
        }}</Label>
        <Select v-model="rendererType" @update:model-value="createRenderer">
          <SelectTrigger size="sm" class="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in rendererTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/antialias")
        }}</Label>
        <Checkbox v-model="antialias" @update:model-value="createRenderer" />
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/shadows")
        }}</Label>
        <Checkbox v-model="shadows" @update:model-value="updateShadows" />
        <Select v-model="shadowType" @update:model-value="updateShadows">
          <SelectTrigger size="sm" class="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in shadowTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-24 shrink-0 text-xs">{{
          t("sidebar/project/toneMapping")
        }}</Label>
        <Select v-model="toneMapping" @update:model-value="updateToneMapping">
          <SelectTrigger size="sm" class="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in toneMappingOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <NumberField
          v-if="showToneMappingExposure"
          v-model="toneMappingExposure"
          :min="0"
          :max="10"
          class="w-16"
          @update:model-value="updateToneMapping"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </div>

    <div class="space-y-2 border-t pt-3">
      <Tabs default-value="geometries">
        <TabsList class="h-8 w-full">
          <TabsTrigger value="geometries" class="text-xs">
            {{ t("sidebar/project/geometries") }}
          </TabsTrigger>
          <TabsTrigger value="materials" class="text-xs">
            {{ t("sidebar/project/materials") }}
          </TabsTrigger>
          <TabsTrigger value="textures" class="text-xs">
            {{ t("sidebar/project/textures") }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="geometries" class="space-y-2">
          <ScrollArea class="h-[140px] rounded-md border">
            <div class="space-y-0.5 p-1">
              <button
                v-for="item in geometriesList"
                :key="item.id"
                type="button"
                class="hover:bg-accent block w-full truncate rounded-sm px-2 py-1 text-left text-xs"
                :class="{ 'bg-accent': selectedGeometryId === item.id }"
                @click="selectedGeometryId = item.id"
              >
                {{ item.label }}
              </button>
            </div>
          </ScrollArea>
          <div class="flex items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              class="text-xs"
              @click="assignGeometry"
            >
              {{ t("sidebar/project/Assign") }}
            </Button>
            <span class="text-muted-foreground text-xs">
              {{ geometriesList.length }}
              {{ t("sidebar/project/geometries").toLowerCase() }}
            </span>
          </div>
        </TabsContent>

        <TabsContent value="materials" class="space-y-2">
          <ScrollArea class="h-[140px] rounded-md border">
            <div class="space-y-0.5 p-1">
              <button
                v-for="item in materialsList"
                :key="item.id"
                type="button"
                class="hover:bg-accent block w-full truncate rounded-sm px-2 py-1 text-left text-xs"
                :class="{ 'bg-accent': selectedMaterialId === item.id }"
                @click="selectedMaterialId = item.id"
              >
                {{ item.label }}
              </button>
            </div>
          </ScrollArea>
          <div class="flex items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              class="text-xs"
              @click="assignMaterial"
            >
              {{ t("sidebar/project/Assign") }}
            </Button>
            <span class="text-muted-foreground text-xs">
              {{ materialsList.length }}
              {{ t("sidebar/project/materials").toLowerCase() }}
            </span>
          </div>
        </TabsContent>

        <TabsContent value="textures" class="space-y-2">
          <ScrollArea class="h-[140px] rounded-md border">
            <div class="space-y-0.5 p-1">
              <div
                v-for="item in texturesList"
                :key="item.id"
                class="truncate rounded-sm px-2 py-1 text-xs"
              >
                {{ item.label }}
              </div>
            </div>
          </ScrollArea>
          <div class="flex items-center justify-end">
            <span class="text-muted-foreground text-xs">
              {{ texturesList.length }}
              {{ t("sidebar/project/textures").toLowerCase() }}
            </span>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>
