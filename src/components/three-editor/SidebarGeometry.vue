<script setup lang="ts">
// @ts-nocheck
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import * as THREE from "three"
import { VertexNormalsHelper } from "three/addons/helpers/VertexNormalsHelper.js"

import { useEditor } from "./composables/useEditorContext"
import GeometryParameters from "./GeometryParameters.vue"

import { SetGeometryValueCommand } from "./commands/SetGeometryValueCommand"

import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const SIMPLE_TYPES = new Set([
  "BoxGeometry",
  "CapsuleGeometry",
  "CircleGeometry",
  "CylinderGeometry",
  "DodecahedronGeometry",
  "IcosahedronGeometry",
  "OctahedronGeometry",
  "PlaneGeometry",
  "RingGeometry",
  "SphereGeometry",
  "TetrahedronGeometry",
  "TorusGeometry",
  "TorusKnotGeometry"
])

const selected = ref<any>(null)
const geometryType = ref("")
const geometryUUID = ref("")
const geometryName = ref("")
const geometryUserData = ref("{}")
const geometryUserDataValid = ref(true)
const boundingBox = ref<[number, number, number]>([0, 0, 0])
const showHelpers = ref(false)
const vertexNormalsSize = ref(1)
const attributesInfo = ref<Array<{ name: string; info: string }>>([])
const morphAttributesInfo = ref<Array<{ name: string; count: number }>>([])
const morphTargetsRelative = ref(false)
const morphs = ref<Array<{ index: number; name: string; value: number }>>([])

const geometryParamsRef = ref<InstanceType<typeof GeometryParameters> | null>(
  null
)
const legacyParamsRef = ref<HTMLDivElement | null>(null)

let legacyPanelInstance: any = null
let legacyPanelType: string | null = null

const paramsMode = computed(() => {
  const type = geometryType.value
  if (SIMPLE_TYPES.has(type)) return "simple"
  if (type === "BufferGeometry" || type === "InstancedBufferGeometry")
    return "modifiers"
  return "legacy"
})

function onUuidRenew() {
  if (!selected.value) return
  geometryUUID.value = THREE.MathUtils.generateUUID()
  editor.execute(
    new SetGeometryValueCommand(
      editor,
      selected.value,
      "uuid",
      geometryUUID.value
    )
  )
}

function onNameChange() {
  if (!selected.value) return
  editor.execute(
    new SetGeometryValueCommand(
      editor,
      selected.value,
      "name",
      geometryName.value
    )
  )
}

function onUserDataChange() {
  if (!selected.value) return
  try {
    const userData = JSON.parse(geometryUserData.value)
    if (
      JSON.stringify(selected.value.geometry.userData) !==
      JSON.stringify(userData)
    ) {
      editor.execute(
        new SetGeometryValueCommand(
          editor,
          selected.value,
          "userData",
          userData
        )
      )
      build()
    }
    geometryUserDataValid.value = true
  } catch (error) {
    geometryUserDataValid.value = false
  }
}

function toggleVertexNormalsHelper() {
  const object = selected.value
  if (!object) return

  if (editor.helpers[object.id] === undefined) {
    editor.addHelper(
      object,
      new VertexNormalsHelper(object, vertexNormalsSize.value)
    )
  } else {
    editor.removeHelper(object)
  }

  signals.sceneGraphChanged.dispatch()
}

function onVertexNormalsSizeChange() {
  const object = selected.value
  if (!object) return

  const helper = editor.helpers[object.id]
  if (helper !== undefined && helper.isVertexNormalsHelper === true) {
    helper.size = vertexNormalsSize.value
    signals.objectChanged.dispatch(object)
  }
}

function exportJson() {
  const object = selected.value
  if (!object) return

  const geometry = object.geometry
  let output = geometry.toJSON()

  try {
    output = JSON.stringify(output, null, "\t")
    output = output.replace(/[\n\t]+([\d\.e\-\[\]]+)/g, "$1")
  } catch (error) {
    output = JSON.stringify(output)
  }

  editor.utils.save(
    new Blob([output]),
    `${geometryName.value || "geometry"}.json`
  )
}

function onMorphInfluenceChange(morph: { index: number; value: number }) {
  const object = selected.value
  if (!object?.morphTargetInfluences) return

  object.morphTargetInfluences[morph.index] = morph.value
  signals.objectChanged.dispatch(object)
}

async function mountLegacyPanel(object: any) {
  const type = object.geometry.type
  if (legacyPanelType === type && legacyPanelInstance) return

  if (legacyParamsRef.value) legacyParamsRef.value.innerHTML = ""
  legacyPanelInstance = null
  legacyPanelType = null

  if (type === "BufferGeometry" || type === "InstancedBufferGeometry") return

  const { GeometryParametersPanel } = await import(
    `./Sidebar.Geometry.${type}.ts`
  )
  legacyPanelInstance = new GeometryParametersPanel(editor, object)
  legacyParamsRef.value?.appendChild(legacyPanelInstance.dom)
  legacyPanelType = type
}

function computeAttributesInfo() {
  const geometry = selected.value?.geometry
  if (!geometry) {
    attributesInfo.value = []
    morphAttributesInfo.value = []
    return
  }

  const info: Array<{ name: string; info: string }> = []

  if (geometry.index !== null) {
    info.push({
      name: t("sidebar/geometry/buffer_geometry/index"),
      info: editor.utils.formatNumber(geometry.index.count)
    })
  }

  for (const name in geometry.attributes) {
    const attribute = geometry.attributes[name]
    let text = `${editor.utils.formatNumber(attribute.count)} (${attribute.itemSize})`
    if (attribute.isInterleavedBufferAttribute) {
      text += ` (${attribute.data.stride})`
    }
    info.push({ name, info: text })
  }

  attributesInfo.value = info

  const morphAttributes = geometry.morphAttributes
  const morphNames = Object.keys(morphAttributes)
  morphAttributesInfo.value = morphNames.map((name) => ({
    name,
    count: morphAttributes[name].length
  }))
  morphTargetsRelative.value = geometry.morphTargetsRelative
}

async function build() {
  const object = selected.value
  if (!object?.geometry) return

  const geometry = object.geometry

  geometryType.value = geometry.type
  geometryUUID.value = geometry.uuid
  geometryName.value = geometry.name

  await mountLegacyPanel(object)

  if (geometry.boundingBox === null) geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  boundingBox.value = [
    Math.floor((bb.max.x - bb.min.x) * 1000) / 1000,
    Math.floor((bb.max.y - bb.min.y) * 1000) / 1000,
    Math.floor((bb.max.z - bb.min.z) * 1000) / 1000
  ]

  showHelpers.value = geometry.hasAttribute("normal")

  geometryUserData.value = JSON.stringify(geometry.userData, null, "  ")
  geometryUserDataValid.value = true

  computeAttributesInfo()

  const helper = editor.helpers[object.id]
  if (helper !== undefined && helper.isVertexNormalsHelper === true) {
    editor.removeHelper(object)
    editor.addHelper(
      object,
      new VertexNormalsHelper(object, vertexNormalsSize.value)
    )
  }

  if (object.morphTargetInfluences) {
    const dictionary = object.morphTargetDictionary
    const influences = object.morphTargetInfluences
    morphs.value = Object.keys(dictionary).map((name, index) => ({
      index,
      name,
      value: influences[index]
    }))
  } else {
    morphs.value = []
  }
}

function refreshMorphs() {
  const object = selected.value
  if (object !== null && object.morphTargetInfluences) {
    for (const morph of morphs.value) {
      morph.value = object.morphTargetInfluences[morph.index]
    }
  }
}

function onObjectSelected(object: any) {
  selected.value = object && object.geometry ? object : null
  legacyPanelType = null
  if (selected.value) build()
}

function onGeometryChanged(object: any) {
  if (object !== selected.value) return
  build()
  geometryParamsRef.value?.refresh?.()
}

onMounted(() => {
  onObjectSelected(editor.selected)

  signals.objectSelected.add(onObjectSelected)
  signals.geometryChanged.add(onGeometryChanged)
  signals.morphTargetsUpdated.add(refreshMorphs)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.geometryChanged.remove(onGeometryChanged)
  signals.morphTargetsUpdated.remove(refreshMorphs)
})
</script>

<template>
  <div v-show="selected" class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/type")
      }}</Label>
      <span class="text-xs">{{ geometryType }}</span>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/uuid")
      }}</Label>
      <input
        :value="geometryUUID"
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
        {{ t("sidebar/geometry/new") }}
      </Button>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/name")
      }}</Label>
      <input
        v-model="geometryName"
        type="text"
        class="border-input h-7 w-[150px] rounded-md border bg-transparent px-2 text-xs"
        @change="onNameChange"
      />
    </div>

    <GeometryParameters
      v-if="paramsMode === 'simple' && selected"
      ref="geometryParamsRef"
      :object="selected"
    />
    <div
      v-show="paramsMode === 'legacy'"
      ref="legacyParamsRef"
      class="te-legacy-geometry-params"
    />
    <div v-if="paramsMode === 'modifiers'" class="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        class="text-xs"
        @click="
          () => {
            selected.geometry.computeVertexNormals()
            signals.geometryChanged.dispatch(selected)
          }
        "
      >
        {{ t("sidebar/geometry/compute_vertex_normals") }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="text-xs"
        @click="
          () => {
            selected.geometry.center()
            signals.geometryChanged.dispatch(selected)
          }
        "
      >
        {{ t("sidebar/geometry/center") }}
      </Button>
    </div>

    <div v-if="attributesInfo.length" class="flex items-start gap-2">
      <Label class="w-32 shrink-0 text-xs">
        {{ t("sidebar/geometry/buffer_geometry/attributes") }}
      </Label>
      <div class="space-y-0.5 text-xs">
        <div v-for="attr in attributesInfo" :key="attr.name" class="flex gap-2">
          <span class="w-16 shrink-0">{{ attr.name }}</span>
          <span class="text-muted-foreground">{{ attr.info }}</span>
        </div>
      </div>
    </div>

    <div v-if="morphAttributesInfo.length" class="flex items-start gap-2">
      <Label class="w-32 shrink-0 text-xs">
        {{ t("sidebar/geometry/buffer_geometry/morphAttributes") }}
      </Label>
      <div class="space-y-0.5 text-xs">
        <div
          v-for="attr in morphAttributesInfo"
          :key="attr.name"
          class="flex gap-2"
        >
          <span class="w-16 shrink-0">{{ attr.name }}</span>
          <span class="text-muted-foreground">{{ attr.count }}</span>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/geometry/bounds")
      }}</Label>
      <span class="text-xs">{{ boundingBox.join(", ") }}</span>
    </div>

    <div class="space-y-1">
      <Label class="text-xs">{{ t("sidebar/geometry/userdata") }}</Label>
      <Textarea
        v-model="geometryUserData"
        rows="4"
        class="text-xs"
        :class="geometryUserDataValid ? '' : 'border-destructive'"
        @change="onUserDataChange"
      />
    </div>

    <div v-if="showHelpers" class="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs"
        @click="toggleVertexNormalsHelper"
      >
        {{ t("sidebar/geometry/show_vertex_normals") }}
      </Button>
      <NumberField
        v-model="vertexNormalsSize"
        :min="0"
        class="w-16"
        @update:model-value="onVertexNormalsSizeChange"
      >
        <NumberFieldContent>
          <NumberFieldInput class="h-7 text-xs" />
        </NumberFieldContent>
      </NumberField>
    </div>

    <Button size="sm" variant="outline" class="text-xs" @click="exportJson">
      {{ t("sidebar/geometry/export") }}
    </Button>

    <div v-if="morphs.length" class="space-y-2 border-t pt-3">
      <Label class="text-xs uppercase">{{ t("sidebar/geometry/morph") }}</Label>
      <div
        v-for="morph in morphs"
        :key="morph.index"
        class="flex items-center gap-2"
      >
        <span class="w-32 shrink-0 truncate text-xs">{{ morph.name }}</span>
        <NumberField
          v-model="morph.value"
          :min="0"
          :max="1"
          class="w-20"
          @update:model-value="onMorphInfluenceChange(morph)"
        >
          <NumberFieldContent>
            <NumberFieldInput class="h-7 text-xs" />
          </NumberFieldContent>
        </NumberField>
      </div>
    </div>
  </div>
</template>
