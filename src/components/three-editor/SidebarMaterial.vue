<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { UITexture } from "./libs/ui.three"
import { TextureParametersDialog } from "./TextureParametersDialog"

import { SetMaterialCommand } from "./commands/SetMaterialCommand"
import { SetMaterialValueCommand } from "./commands/SetMaterialValueCommand"
import { SetMaterialColorCommand } from "./commands/SetMaterialColorCommand"
import { SetMaterialRangeCommand } from "./commands/SetMaterialRangeCommand"
import { SetMaterialMapCommand } from "./commands/SetMaterialMapCommand"
import { SetMaterialVectorCommand } from "./commands/SetMaterialVectorCommand"
import { SetTextureParametersCommand } from "./commands/SetTextureParametersCommand"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput
} from "@/components/ui/number-field"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const materialClasses = {
  LineBasicMaterial: THREE.LineBasicMaterial,
  LineDashedMaterial: THREE.LineDashedMaterial,
  MeshBasicMaterial: THREE.MeshBasicMaterial,
  MeshDepthMaterial: THREE.MeshDepthMaterial,
  MeshNormalMaterial: THREE.MeshNormalMaterial,
  MeshLambertMaterial: THREE.MeshLambertMaterial,
  MeshMatcapMaterial: THREE.MeshMatcapMaterial,
  MeshPhongMaterial: THREE.MeshPhongMaterial,
  MeshToonMaterial: THREE.MeshToonMaterial,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  MeshPhysicalMaterial: THREE.MeshPhysicalMaterial,
  RawShaderMaterial: THREE.RawShaderMaterial,
  ShaderMaterial: THREE.ShaderMaterial,
  ShadowMaterial: THREE.ShadowMaterial,
  SpriteMaterial: THREE.SpriteMaterial,
  PointsMaterial: THREE.PointsMaterial
}

const vertexShaderVariables = [
  "uniform mat4 projectionMatrix;",
  "uniform mat4 modelViewMatrix;\n",
  "attribute vec3 position;\n\n"
].join("\n")

const meshMaterialOptions = [
  "MeshBasicMaterial",
  "MeshDepthMaterial",
  "MeshNormalMaterial",
  "MeshLambertMaterial",
  "MeshMatcapMaterial",
  "MeshPhongMaterial",
  "MeshToonMaterial",
  "MeshStandardMaterial",
  "MeshPhysicalMaterial",
  "RawShaderMaterial",
  "ShaderMaterial",
  "ShadowMaterial"
]
const lineMaterialOptions = [
  "LineBasicMaterial",
  "LineDashedMaterial",
  "RawShaderMaterial",
  "ShaderMaterial"
]
const spriteMaterialOptions = [
  "SpriteMaterial",
  "RawShaderMaterial",
  "ShaderMaterial"
]
const pointsMaterialOptions = [
  "PointsMaterial",
  "RawShaderMaterial",
  "ShaderMaterial"
]

const colorMaps = [
  "map",
  "emissiveMap",
  "sheenColorMap",
  "specularColorMap",
  "envMap"
]

// ----- row configuration -----

const numberRows = [
  { key: "shininess", label: t("sidebar/material/shininess") },
  { key: "reflectivity", label: t("sidebar/material/reflectivity") },
  {
    key: "ior",
    label: t("sidebar/material/ior"),
    range: [1, 2.333],
    precision: 3
  },
  { key: "roughness", label: t("sidebar/material/roughness"), range: [0, 1] },
  { key: "metalness", label: t("sidebar/material/metalness"), range: [0, 1] },
  { key: "clearcoat", label: t("sidebar/material/clearcoat"), range: [0, 1] },
  {
    key: "clearcoatRoughness",
    label: t("sidebar/material/clearcoatroughness"),
    range: [0, 1]
  },
  {
    key: "dispersion",
    label: t("sidebar/material/dispersion"),
    range: [0, 10]
  },
  {
    key: "iridescence",
    label: t("sidebar/material/iridescence"),
    range: [0, 1]
  },
  {
    key: "iridescenceIOR",
    label: t("sidebar/material/iridescenceIOR"),
    range: [1, 5]
  },
  { key: "sheen", label: t("sidebar/material/sheen"), range: [0, 1] },
  {
    key: "sheenRoughness",
    label: t("sidebar/material/sheenroughness"),
    range: [0, 1]
  },
  {
    key: "transmission",
    label: t("sidebar/material/transmission"),
    range: [0, 1]
  },
  {
    key: "attenuationDistance",
    label: t("sidebar/material/attenuationDistance")
  },
  { key: "thickness", label: t("sidebar/material/thickness") },
  { key: "size", label: t("sidebar/material/size"), range: [0, Infinity] },
  { key: "opacity", label: t("sidebar/material/opacity"), range: [0, 1] },
  { key: "alphaTest", label: t("sidebar/material/alphatest"), range: [0, 1] }
]

const colorRows = [
  { key: "color", label: t("sidebar/material/color") },
  { key: "specular", label: t("sidebar/material/specular") },
  {
    key: "emissive",
    label: t("sidebar/material/emissive"),
    intensityProp: "emissiveIntensity"
  },
  { key: "sheenColor", label: t("sidebar/material/sheencolor") },
  { key: "attenuationColor", label: t("sidebar/material/attenuationColor") }
]

const booleanRows = [
  { key: "vertexColors", label: t("sidebar/material/vertexcolors") },
  { key: "sizeAttenuation", label: t("sidebar/material/sizeAttenuation") },
  { key: "flatShading", label: t("sidebar/material/flatShading") },
  { key: "transparent", label: t("sidebar/material/transparent") },
  { key: "forceSinglePass", label: t("sidebar/material/forcesinglepass") },
  { key: "depthTest", label: t("sidebar/material/depthtest") },
  { key: "depthWrite", label: t("sidebar/material/depthwrite") },
  { key: "wireframe", label: t("sidebar/material/wireframe") }
]

const selectRows = [
  {
    key: "depthPacking",
    label: t("sidebar/material/depthPacking"),
    options: {
      [THREE.BasicDepthPacking]: "Basic",
      [THREE.RGBADepthPacking]: "RGBA"
    }
  },
  {
    key: "side",
    label: t("sidebar/material/side"),
    options: { 0: "Front", 1: "Back", 2: "Double" }
  },
  {
    key: "blending",
    label: t("sidebar/material/blending"),
    options: {
      0: "No",
      1: "Normal",
      2: "Additive",
      3: "Subtractive",
      4: "Multiply",
      5: "Custom"
    }
  }
]

const rangeRows = [
  {
    key: "iridescenceThicknessRange",
    label: t("sidebar/material/iridescenceThicknessMax")
  }
]

const mapRows = [
  { key: "map", label: t("sidebar/material/map") },
  { key: "specularMap", label: t("sidebar/material/specularmap") },
  { key: "emissiveMap", label: t("sidebar/material/emissivemap") },
  { key: "matcap", label: t("sidebar/material/matcap") },
  { key: "alphaMap", label: t("sidebar/material/alphamap") },
  {
    key: "bumpMap",
    label: t("sidebar/material/bumpmap"),
    extra: "scale",
    extraProp: "bumpScale"
  },
  {
    key: "normalMap",
    label: t("sidebar/material/normalmap"),
    extra: "scaleXY",
    extraProp: "normalScale"
  },
  { key: "clearcoatMap", label: t("sidebar/material/clearcoatmap") },
  {
    key: "clearcoatNormalMap",
    label: t("sidebar/material/clearcoatnormalmap")
  },
  {
    key: "clearcoatRoughnessMap",
    label: t("sidebar/material/clearcoatroughnessmap")
  },
  {
    key: "displacementMap",
    label: t("sidebar/material/displacementmap"),
    extra: "scale",
    extraProp: "displacementScale"
  },
  { key: "roughnessMap", label: t("sidebar/material/roughnessmap") },
  { key: "metalnessMap", label: t("sidebar/material/metalnessmap") },
  { key: "iridescenceMap", label: t("sidebar/material/iridescencemap") },
  { key: "sheenColorMap", label: t("sidebar/material/sheencolormap") },
  { key: "sheenRoughnessMap", label: t("sidebar/material/sheenroughnessmap") },
  {
    key: "iridescenceThicknessMap",
    label: t("sidebar/material/iridescencethicknessmap"),
    extra: "range",
    extraProp: "iridescenceThicknessRange"
  },
  { key: "envMap", label: t("sidebar/material/envmap") },
  { key: "lightMap", label: t("sidebar/material/lightmap") },
  {
    key: "aoMap",
    label: t("sidebar/material/aomap"),
    extra: "intensity",
    extraProp: "aoMapIntensity"
  },
  { key: "gradientMap", label: t("sidebar/material/gradientmap") },
  { key: "transmissionMap", label: t("sidebar/material/transmissionmap") },
  { key: "thicknessMap", label: t("sidebar/material/thicknessmap") }
]

// ----- state -----

const currentObject = shallowRef<any>(null)
const currentSlot = ref(0)
const material = shallowRef<any>(null)

const showSlotSelector = ref(false)
const slotValue = ref("0")
const slotOptions = ref<Record<string, string>>({})

const materialType = ref("")
const materialTypeOptions = ref<string[]>(meshMaterialOptions)
const materialUUID = ref("")
const materialName = ref("")
const materialUserData = ref("")
const materialUserDataValid = ref(true)
const showProgram = ref(false)

const present = reactive<Record<string, boolean>>({})
const values = reactive<Record<string, any>>({})
const mapEnabled = reactive<Record<string, boolean>>({})
const mapHasTexture = reactive<Record<string, boolean>>({})

const mapContainerRefs = ref<HTMLElement[]>([])
const mapWidgets: Record<string, any> = {}

// ----- helpers -----

function hexToInt(hex: string) {
  return parseInt(hex.replace("#", ""), 16)
}

function intToHex(value: number) {
  return "#" + value.toString(16).padStart(6, "0")
}

function setValue(prop: string, value: any) {
  const m = material.value
  if (!m) return
  if (m[prop] !== value) {
    editor.execute(
      new SetMaterialValueCommand(
        editor,
        currentObject.value,
        prop,
        value,
        currentSlot.value
      )
    )
  }
}

function setSelectValue(prop: string) {
  setValue(prop, Number(values[prop]))
}

function setColorValue(prop: string, intensityProp?: string) {
  const m = material.value
  if (!m) return
  const hex = hexToInt(values[prop])
  if (m[prop].getHex() !== hex) {
    editor.execute(
      new SetMaterialColorCommand(
        editor,
        currentObject.value,
        prop,
        hex,
        currentSlot.value
      )
    )
  }
  if (intensityProp) setValue(intensityProp, values[intensityProp])
}

function setVectorXY(prop: string) {
  const m = material.value
  if (!m) return
  const x = values[`${prop}_x`]
  const y = values[`${prop}_y`]
  if (m[prop].x !== x || m[prop].y !== y) {
    editor.execute(
      new SetMaterialVectorCommand(
        editor,
        currentObject.value,
        prop,
        [x, y],
        currentSlot.value
      )
    )
  }
}

function setRangeMax(prop: string) {
  const m = material.value
  if (!m) return
  const max = values[`${prop}_max`]
  if (m[prop][1] !== max) {
    editor.execute(
      new SetMaterialRangeCommand(
        editor,
        currentObject.value,
        prop,
        m[prop][0],
        max,
        currentSlot.value
      )
    )
  }
}

function setRange(prop: string) {
  const m = material.value
  if (!m) return
  const min = values[`${prop}_min`]
  const max = values[`${prop}_max`]
  if (m[prop][0] !== min || m[prop][1] !== max) {
    editor.execute(
      new SetMaterialRangeCommand(
        editor,
        currentObject.value,
        prop,
        min,
        max,
        currentSlot.value
      )
    )
  }
}

function applyMap(row: any, newMap: any) {
  const m = material.value
  const object = currentObject.value
  if (!m || m[row.key] === newMap) return

  if (newMap !== null) {
    const geometry = object.geometry
    if (geometry?.hasAttribute?.("uv") === false) {
      console.warn("Geometry doesn't have uvs:", geometry)
    }
    if (row.key === "envMap")
      newMap.mapping = THREE.EquirectangularReflectionMapping
  }

  editor.execute(
    new SetMaterialMapCommand(
      editor,
      object,
      row.key,
      newMap,
      currentSlot.value
    )
  )
}

function onMapEnabledChange(row: any) {
  const widget = mapWidgets[row.key]
  const newMap = mapEnabled[row.key] ? (widget?.getValue() ?? null) : null
  applyMap(row, newMap)
}

function onMapTextureChange(row: any, texture: any) {
  const m = material.value
  if (texture !== null && m) {
    if (
      colorMaps.includes(row.key) &&
      texture.isDataTexture !== true &&
      texture.colorSpace !== THREE.SRGBColorSpace
    ) {
      texture.colorSpace = THREE.SRGBColorSpace
      m.needsUpdate = true
    }
  }

  mapEnabled[row.key] = true
  mapHasTexture[row.key] = texture !== null
  applyMap(row, texture)
}

async function onMapSettings(row: any) {
  const widget = mapWidgets[row.key]
  const texture = widget?.getValue()
  if (!texture) return

  const dialog = new TextureParametersDialog(editor, texture)

  try {
    const parameters = await dialog.show()
    editor.execute(new SetTextureParametersCommand(editor, texture, parameters))
  } catch (error) {
    // dialog cancelled
  }
}

function onUuidRenew() {
  if (!material.value) return
  const newUuid = THREE.MathUtils.generateUUID()
  materialUUID.value = newUuid
  editor.execute(
    new SetMaterialValueCommand(
      editor,
      currentObject.value,
      "uuid",
      newUuid,
      currentSlot.value
    )
  )
}

function onNameChange() {
  if (!material.value) return
  editor.execute(
    new SetMaterialValueCommand(
      editor,
      currentObject.value,
      "name",
      materialName.value,
      currentSlot.value
    )
  )
}

function onUserDataChange() {
  if (!material.value) return
  try {
    const parsed = JSON.parse(materialUserData.value)
    if (JSON.stringify(material.value.userData) !== JSON.stringify(parsed)) {
      editor.execute(
        new SetMaterialValueCommand(
          editor,
          currentObject.value,
          "userData",
          parsed,
          currentSlot.value
        )
      )
    }
    materialUserDataValid.value = true
  } catch (error) {
    materialUserDataValid.value = false
  }
}

function onSlotSelect(value: string) {
  const slot = Number(value)
  if (slot !== currentSlot.value) {
    currentSlot.value = slot
    editor.signals.materialChanged.dispatch(
      currentObject.value,
      currentSlot.value
    )
  }
}

function onMaterialTypeChange(newTypeName: string) {
  const object = currentObject.value
  if (!object) return

  const currentMaterial = editor.getObjectMaterial(object, currentSlot.value)
  if (currentMaterial.type === newTypeName) return

  const newMaterial = new materialClasses[newTypeName]()

  if (newMaterial.type === "RawShaderMaterial") {
    newMaterial.vertexShader = vertexShaderVariables + newMaterial.vertexShader
  }

  const objectMaterial = object.material

  if (
    newMaterial.type === "MeshPhysicalMaterial" &&
    currentMaterial.type === "MeshStandardMaterial"
  ) {
    const properties = [
      "color",
      "emissive",
      "roughness",
      "metalness",
      "map",
      "emissiveMap",
      "alphaMap",
      "bumpMap",
      "normalMap",
      "normalScale",
      "displacementMap",
      "roughnessMap",
      "metalnessMap",
      "envMap",
      "lightMap",
      "aoMap",
      "side"
    ]

    for (const property of properties) {
      const value = currentMaterial[property]
      if (value === null) continue
      newMaterial[property] =
        value["clone"] !== undefined ? value.clone() : value
    }
  }

  if (Array.isArray(objectMaterial)) {
    editor.removeMaterial(objectMaterial[currentSlot.value])
  } else {
    editor.removeMaterial(objectMaterial)
  }

  editor.execute(
    new SetMaterialCommand(editor, object, newMaterial, currentSlot.value),
    strings.getKey("command/SetMaterial") + ": " + newTypeName
  )
  editor.addMaterial(newMaterial)
}

function exportJson() {
  const object = currentObject.value
  if (!object) return

  const mat = Array.isArray(object.material)
    ? object.material[currentSlot.value]
    : object.material

  let output = mat.toJSON()

  try {
    output = JSON.stringify(output, null, "\t")
    output = output.replace(/[\n\t]+([\d\.e\-\[\]]+)/g, "$1")
  } catch (error) {
    output = JSON.stringify(output)
  }

  editor.utils.save(
    new Blob([output]),
    `${materialName.value || "material"}.json`
  )
}

function onProgram(part: string) {
  signals.editScript.dispatch(currentObject.value, part)
}

// ----- refresh -----

function refreshUI() {
  const object = currentObject.value
  if (!object) return

  const objectMaterial = object.material

  if (Array.isArray(objectMaterial)) {
    const opts: Record<string, string> = {}
    currentSlot.value = Math.max(
      0,
      Math.min(objectMaterial.length, currentSlot.value)
    )
    objectMaterial.forEach((mat, i) => {
      opts[i] = `${i + 1}: ${mat.name}`
    })
    slotOptions.value = opts
    slotValue.value = String(currentSlot.value)
    showSlotSelector.value = true
  } else {
    showSlotSelector.value = false
  }

  const m = editor.getObjectMaterial(object, currentSlot.value)
  material.value = m
  if (!m) return

  if (m.uuid !== undefined) materialUUID.value = m.uuid
  if (m.name !== undefined) materialName.value = m.name

  if (object.isMesh) materialTypeOptions.value = meshMaterialOptions
  else if (object.isSprite) materialTypeOptions.value = spriteMaterialOptions
  else if (object.isPoints) materialTypeOptions.value = pointsMaterialOptions
  else if (object.isLine) materialTypeOptions.value = lineMaterialOptions

  materialType.value = m.type
  showProgram.value = "vertexShader" in m

  for (const row of numberRows) {
    present[row.key] = row.key in m
    if (present[row.key]) values[row.key] = m[row.key]
  }
  for (const row of booleanRows) {
    present[row.key] = row.key in m
    if (present[row.key]) values[row.key] = m[row.key]
  }
  for (const row of colorRows) {
    present[row.key] = row.key in m
    if (present[row.key]) {
      values[row.key] = intToHex(m[row.key].getHex())
      if (row.intensityProp) values[row.intensityProp] = m[row.intensityProp]
    }
  }
  for (const row of selectRows) {
    present[row.key] = row.key in m
    if (present[row.key]) values[row.key] = String(m[row.key])
  }
  for (const row of rangeRows) {
    present[row.key] = row.key in m
    if (present[row.key]) {
      values[`${row.key}_min`] = m[row.key][0]
      values[`${row.key}_max`] = m[row.key][1]
    }
  }

  for (const row of mapRows) {
    mapWidgets[row.key]?.setValue(null)
  }

  for (const row of mapRows) {
    present[row.key] = row.key in m
    if (present[row.key]) {
      const texture = m[row.key]
      mapEnabled[row.key] = texture !== null
      mapHasTexture[row.key] = texture !== null
      if (texture !== null) mapWidgets[row.key]?.setValue(texture)

      if (row.extra === "scale" || row.extra === "intensity") {
        values[row.extraProp] = m[row.extraProp]
      } else if (row.extra === "scaleXY") {
        values[`${row.extraProp}_x`] = m[row.extraProp].x
        values[`${row.extraProp}_y`] = m[row.extraProp].y
      } else if (row.extra === "range") {
        values[`${row.extraProp}_min`] = m[row.extraProp][0]
        values[`${row.extraProp}_max`] = m[row.extraProp][1]
      }
    }
  }

  try {
    materialUserData.value = JSON.stringify(m.userData, null, "  ")
  } catch (error) {
    console.log(error)
  }
  materialUserDataValid.value = true
}

function hasMaterial(object: any) {
  if (!object || !object.material) return false
  if (Array.isArray(object.material) && object.material.length === 0)
    return false
  return true
}

function onObjectSelected(object: any) {
  if (hasMaterial(object)) {
    currentObject.value = object
    refreshUI()
  } else {
    currentObject.value = null
    material.value = null
  }
}

onMounted(() => {
  mapRows.forEach((row, i) => {
    const el = mapContainerRefs.value[i]
    if (!el) return
    const widget = new UITexture(editor).onChange((texture: any) =>
      onMapTextureChange(row, texture)
    )
    el.appendChild(widget.dom)
    mapWidgets[row.key] = widget
  })

  onObjectSelected(editor.selected)

  signals.objectSelected.add(onObjectSelected)
  signals.materialChanged.add(refreshUI)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.materialChanged.remove(refreshUI)
})
</script>

<template>
  <div v-show="currentObject" class="space-y-3 p-3">
    <div v-if="showSlotSelector" class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/material/slot")
      }}</Label>
      <Select :model-value="slotValue" @update:model-value="onSlotSelect">
        <SelectTrigger size="sm" class="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="(label, val) in slotOptions"
            :key="val"
            :value="String(val)"
          >
            {{ label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/material/type")
      }}</Label>
      <Select
        :model-value="materialType"
        @update:model-value="onMaterialTypeChange"
      >
        <SelectTrigger size="sm" class="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in materialTypeOptions"
            :key="opt"
            :value="opt"
          >
            {{ opt }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/material/uuid")
      }}</Label>
      <input
        :value="materialUUID"
        type="text"
        disabled
        class="border-input h-7 w-[110px] rounded-md border bg-transparent px-2 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="onUuidRenew"
      >
        {{ t("sidebar/material/new") }}
      </Button>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/material/name")
      }}</Label>
      <input
        v-model="materialName"
        type="text"
        class="border-input h-7 w-[150px] rounded-md border bg-transparent px-2 text-xs"
        @change="onNameChange"
      />
    </div>

    <div v-if="showProgram" class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/material/program")
      }}</Label>
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="onProgram('programInfo')"
      >
        {{ t("sidebar/material/info") }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="onProgram('vertexShader')"
      >
        {{ t("sidebar/material/vertex") }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="onProgram('fragmentShader')"
      >
        {{ t("sidebar/material/fragment") }}
      </Button>
    </div>

    <template v-for="row in colorRows" :key="row.key">
      <div v-show="present[row.key]" class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <input
          v-model="values[row.key]"
          type="color"
          class="border-input h-7 w-10 rounded-md border"
          @input="setColorValue(row.key, row.intensityProp)"
        />
        <NumberField
          v-if="row.intensityProp"
          v-model="values[row.intensityProp]"
          :min="0"
          class="w-20"
          @update:model-value="setColorValue(row.key, row.intensityProp)"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </template>

    <template v-for="row in numberRows" :key="row.key">
      <div v-show="present[row.key]" class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <NumberField
          v-model="values[row.key]"
          :min="row.range?.[0]"
          :max="row.range?.[1]"
          class="w-24"
          @update:model-value="setValue(row.key, values[row.key])"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>
    </template>

    <template v-for="row in rangeRows" :key="row.key">
      <div v-show="present[row.key]" class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <NumberField
          v-model="values[`${row.key}_max`]"
          :min="0"
          class="w-24"
          @update:model-value="setRangeMax(row.key)"
        >
          <NumberFieldContent>
            <NumberFieldDecrement />
            <NumberFieldInput class="h-7 text-xs" />
            <NumberFieldIncrement />
          </NumberFieldContent>
        </NumberField>
      </div>
    </template>

    <template v-for="row in booleanRows" :key="row.key">
      <div v-show="present[row.key]" class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <Checkbox
          v-model="values[row.key]"
          @update:model-value="setValue(row.key, values[row.key])"
        />
      </div>
    </template>

    <template v-for="row in selectRows" :key="row.key">
      <div v-show="present[row.key]" class="flex items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <Select
          v-model="values[row.key]"
          @update:model-value="setSelectValue(row.key)"
        >
          <SelectTrigger size="sm" class="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="(label, val) in row.options"
              :key="val"
              :value="String(val)"
            >
              {{ label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </template>

    <template v-for="(row, i) in mapRows" :key="row.key">
      <div v-show="present[row.key]" class="flex flex-wrap items-center gap-2">
        <Label class="w-32 shrink-0 text-xs">{{ row.label }}</Label>
        <Checkbox
          v-model="mapEnabled[row.key]"
          :disabled="!mapHasTexture[row.key]"
          @update:model-value="onMapEnabledChange(row)"
        />
        <div :ref="(el) => (mapContainerRefs[i] = el as HTMLElement)" />
        <Button
          size="sm"
          variant="outline"
          class="h-7 w-7 p-0 text-xs"
          :disabled="!mapHasTexture[row.key]"
          @click="onMapSettings(row)"
        >
          ⚙
        </Button>

        <NumberField
          v-if="row.extra === 'scale'"
          v-model="values[row.extraProp]"
          class="w-16"
          @update:model-value="setValue(row.extraProp, values[row.extraProp])"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>

        <template v-if="row.extra === 'scaleXY'">
          <NumberField
            v-model="values[`${row.extraProp}_x`]"
            class="w-14"
            @update:model-value="setVectorXY(row.extraProp)"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="values[`${row.extraProp}_y`]"
            class="w-14"
            @update:model-value="setVectorXY(row.extraProp)"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
        </template>

        <NumberField
          v-if="row.extra === 'intensity'"
          v-model="values[row.extraProp]"
          :min="0"
          :max="1"
          class="w-16"
          @update:model-value="setValue(row.extraProp, values[row.extraProp])"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>

        <template v-if="row.extra === 'range'">
          <span class="text-muted-foreground text-xs">min</span>
          <NumberField
            v-model="values[`${row.extraProp}_min`]"
            :min="0"
            class="w-16"
            @update:model-value="setRange(row.extraProp)"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
          <span class="text-muted-foreground text-xs">max</span>
          <NumberField
            v-model="values[`${row.extraProp}_max`]"
            :min="0"
            class="w-16"
            @update:model-value="setRange(row.extraProp)"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
        </template>
      </div>
    </template>

    <div class="space-y-1">
      <Label class="text-xs">{{ t("sidebar/material/userdata") }}</Label>
      <Textarea
        v-model="materialUserData"
        rows="4"
        class="text-xs"
        :class="materialUserDataValid ? '' : 'border-destructive'"
        @change="onUserDataChange"
      />
    </div>

    <Button size="sm" variant="outline" class="text-xs" @click="exportJson">
      {{ t("sidebar/material/export") }}
    </Button>
  </div>
</template>
