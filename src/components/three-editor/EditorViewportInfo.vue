<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

import { useEditor } from "./composables/useEditorContext"

defineOptions({ inheritAttrs: false })

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings

function t(key: string) {
  return strings.getKey(key)
}

function pluralize(count: number, singularKey: string, pluralKey: string) {
  const pluralRules = new Intl.PluralRules(editor.config.getKey("language"))
  return t(pluralRules.select(count) === "one" ? singularKey : pluralKey)
}

const objectCount = ref(0)
const vertexCount = ref(0)
const triangleCount = ref(0)
const objects = ref("0")
const vertices = ref("0")
const triangles = ref("0")
const frametime = ref("0")
const samples = ref(0)
const showSamples = ref(false)

function update() {
  const scene = editor.scene

  let objectTotal = 0
  let vertexTotal = 0
  let triangleTotal = 0

  for (let i = 0, l = scene.children.length; i < l; i++) {
    scene.children[i].traverseVisible((object: any) => {
      objectTotal++

      if (object.isMesh || object.isPoints) {
        const geometry = object.geometry
        const positionAttribute = geometry.attributes.position

        if (positionAttribute !== undefined && positionAttribute !== null) {
          vertexTotal += positionAttribute.count
        }

        if (object.isMesh) {
          if (geometry.index !== null) {
            triangleTotal += geometry.index.count / 3
          } else if (
            positionAttribute !== undefined &&
            positionAttribute !== null
          ) {
            triangleTotal += positionAttribute.count / 3
          }
        }
      }
    })
  }

  objectCount.value = objectTotal
  vertexCount.value = vertexTotal
  triangleCount.value = triangleTotal

  objects.value = editor.utils.formatNumber(objectTotal)
  vertices.value = editor.utils.formatNumber(vertexTotal)
  triangles.value = editor.utils.formatNumber(triangleTotal)
}

function updateFrametime(value: number) {
  frametime.value = Number(value).toFixed(2)
}

function onPathTracerUpdated(value: number) {
  samples.value = Math.floor(value)
}

function onViewportShadingChanged() {
  showSamples.value = editor.viewportShading === "realistic"
}

onMounted(() => {
  signals.objectAdded.add(update)
  signals.objectRemoved.add(update)
  signals.objectChanged.add(update)
  signals.geometryChanged.add(update)
  signals.sceneRendered.add(updateFrametime)
  signals.pathTracerUpdated.add(onPathTracerUpdated)
  signals.viewportShadingChanged.add(onViewportShadingChanged)

  update()
})

onBeforeUnmount(() => {
  signals.objectAdded.remove(update)
  signals.objectRemoved.remove(update)
  signals.objectChanged.remove(update)
  signals.geometryChanged.remove(update)
  signals.sceneRendered.remove(updateFrametime)
  signals.pathTracerUpdated.remove(onPathTracerUpdated)
  signals.viewportShadingChanged.remove(onViewportShadingChanged)
})
</script>

<template>
  <div
    v-bind="$attrs"
    class="pointer-events-none text-xs text-white lowercase"
    :style="{ bottom: showSamples ? '62px' : '50px' }"
  >
    <div>
      {{ objects }}
      {{
        pluralize(objectCount, "viewport/info/object", "viewport/info/objects")
      }}
    </div>
    <div>
      {{ vertices }}
      {{
        pluralize(vertexCount, "viewport/info/vertex", "viewport/info/vertices")
      }}
    </div>
    <div>
      {{ triangles }}
      {{
        pluralize(
          triangleCount,
          "viewport/info/triangle",
          "viewport/info/triangles"
        )
      }}
    </div>
    <div>{{ frametime }} {{ t("viewport/info/rendertime") }}</div>
    <div v-if="showSamples">
      {{ samples }}
      {{ pluralize(samples, "viewport/info/sample", "viewport/info/samples") }}
    </div>
  </div>
</template>
