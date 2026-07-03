<script setup lang="ts">
// @ts-nocheck
import { computed, reactive, watch } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { SetGeometryCommand } from "./commands/SetGeometryCommand"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput
} from "@/components/ui/number-field"

const props = defineProps<{ object: any }>()

const editor = useEditor()
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const RAD2DEG = THREE.MathUtils.RAD2DEG
const DEG2RAD = THREE.MathUtils.DEG2RAD

const configs: Record<string, any> = {
  BoxGeometry: {
    fields: [
      { key: "width", label: t("sidebar/geometry/box_geometry/width") },
      { key: "height", label: t("sidebar/geometry/box_geometry/height") },
      { key: "depth", label: t("sidebar/geometry/box_geometry/depth") },
      {
        key: "widthSegments",
        label: t("sidebar/geometry/box_geometry/widthseg"),
        integer: true,
        min: 1
      },
      {
        key: "heightSegments",
        label: t("sidebar/geometry/box_geometry/heightseg"),
        integer: true,
        min: 1
      },
      {
        key: "depthSegments",
        label: t("sidebar/geometry/box_geometry/depthseg"),
        integer: true,
        min: 1
      }
    ],
    build: (v: any) =>
      new THREE.BoxGeometry(
        v.width,
        v.height,
        v.depth,
        v.widthSegments,
        v.heightSegments,
        v.depthSegments
      )
  },
  CapsuleGeometry: {
    fields: [
      { key: "radius", label: t("sidebar/geometry/capsule_geometry/radius") },
      { key: "height", label: t("sidebar/geometry/capsule_geometry/height") },
      {
        key: "capSegments",
        label: t("sidebar/geometry/capsule_geometry/capseg"),
        integer: true,
        min: 1
      },
      {
        key: "radialSegments",
        label: t("sidebar/geometry/capsule_geometry/radialseg"),
        integer: true,
        min: 1
      },
      {
        key: "heightSegments",
        label: t("sidebar/geometry/capsule_geometry/heightseg"),
        integer: true,
        min: 1
      }
    ],
    build: (v: any) =>
      new THREE.CapsuleGeometry(
        v.radius,
        v.height,
        v.capSegments,
        v.radialSegments,
        v.heightSegments
      )
  },
  CircleGeometry: {
    fields: [
      { key: "radius", label: t("sidebar/geometry/circle_geometry/radius") },
      {
        key: "segments",
        label: t("sidebar/geometry/circle_geometry/segments"),
        integer: true,
        min: 3
      },
      {
        key: "thetaStart",
        label: t("sidebar/geometry/circle_geometry/thetastart"),
        degrees: true
      },
      {
        key: "thetaLength",
        label: t("sidebar/geometry/circle_geometry/thetalength"),
        degrees: true
      }
    ],
    build: (v: any) =>
      new THREE.CircleGeometry(
        v.radius,
        v.segments,
        v.thetaStart * DEG2RAD,
        v.thetaLength * DEG2RAD
      )
  },
  CylinderGeometry: {
    fields: [
      {
        key: "radiusTop",
        label: t("sidebar/geometry/cylinder_geometry/radiustop")
      },
      {
        key: "radiusBottom",
        label: t("sidebar/geometry/cylinder_geometry/radiusbottom")
      },
      { key: "height", label: t("sidebar/geometry/cylinder_geometry/height") },
      {
        key: "radialSegments",
        label: t("sidebar/geometry/cylinder_geometry/radialsegments"),
        integer: true,
        min: 1
      },
      {
        key: "heightSegments",
        label: t("sidebar/geometry/cylinder_geometry/heightsegments"),
        integer: true,
        min: 1
      },
      {
        key: "openEnded",
        label: t("sidebar/geometry/cylinder_geometry/openended"),
        boolean: true
      }
    ],
    build: (v: any) =>
      new THREE.CylinderGeometry(
        v.radiusTop,
        v.radiusBottom,
        v.height,
        v.radialSegments,
        v.heightSegments,
        v.openEnded
      )
  },
  PlaneGeometry: {
    fields: [
      { key: "width", label: t("sidebar/geometry/plane_geometry/width") },
      { key: "height", label: t("sidebar/geometry/plane_geometry/height") },
      {
        key: "widthSegments",
        label: t("sidebar/geometry/plane_geometry/widthsegments"),
        integer: true,
        min: 1
      },
      {
        key: "heightSegments",
        label: t("sidebar/geometry/plane_geometry/heightsegments"),
        integer: true,
        min: 1
      }
    ],
    build: (v: any) =>
      new THREE.PlaneGeometry(v.width, v.height, v.widthSegments, v.heightSegments)
  },
  RingGeometry: {
    fields: [
      {
        key: "innerRadius",
        label: t("sidebar/geometry/ring_geometry/innerRadius")
      },
      {
        key: "outerRadius",
        label: t("sidebar/geometry/ring_geometry/outerRadius")
      },
      {
        key: "thetaSegments",
        label: t("sidebar/geometry/ring_geometry/thetaSegments"),
        integer: true,
        min: 3
      },
      {
        key: "phiSegments",
        label: t("sidebar/geometry/ring_geometry/phiSegments"),
        integer: true,
        min: 3
      },
      {
        key: "thetaStart",
        label: t("sidebar/geometry/ring_geometry/thetastart"),
        degrees: true
      },
      {
        key: "thetaLength",
        label: t("sidebar/geometry/ring_geometry/thetalength"),
        degrees: true
      }
    ],
    build: (v: any) =>
      new THREE.RingGeometry(
        v.innerRadius,
        v.outerRadius,
        v.thetaSegments,
        v.phiSegments,
        v.thetaStart * DEG2RAD,
        v.thetaLength * DEG2RAD
      )
  },
  SphereGeometry: {
    fields: [
      { key: "radius", label: t("sidebar/geometry/sphere_geometry/radius") },
      {
        key: "widthSegments",
        label: t("sidebar/geometry/sphere_geometry/widthsegments"),
        integer: true,
        min: 1
      },
      {
        key: "heightSegments",
        label: t("sidebar/geometry/sphere_geometry/heightsegments"),
        integer: true,
        min: 1
      },
      {
        key: "phiStart",
        label: t("sidebar/geometry/sphere_geometry/phistart"),
        degrees: true
      },
      {
        key: "phiLength",
        label: t("sidebar/geometry/sphere_geometry/philength"),
        degrees: true
      },
      {
        key: "thetaStart",
        label: t("sidebar/geometry/sphere_geometry/thetastart"),
        degrees: true
      },
      {
        key: "thetaLength",
        label: t("sidebar/geometry/sphere_geometry/thetalength"),
        degrees: true
      }
    ],
    build: (v: any) =>
      new THREE.SphereGeometry(
        v.radius,
        v.widthSegments,
        v.heightSegments,
        v.phiStart * DEG2RAD,
        v.phiLength * DEG2RAD,
        v.thetaStart * DEG2RAD,
        v.thetaLength * DEG2RAD
      )
  },
  TorusGeometry: {
    fields: [
      { key: "radius", label: t("sidebar/geometry/torus_geometry/radius") },
      { key: "tube", label: t("sidebar/geometry/torus_geometry/tube") },
      {
        key: "radialSegments",
        label: t("sidebar/geometry/torus_geometry/radialsegments"),
        integer: true,
        min: 1
      },
      {
        key: "tubularSegments",
        label: t("sidebar/geometry/torus_geometry/tubularsegments"),
        integer: true,
        min: 1
      },
      { key: "arc", label: t("sidebar/geometry/torus_geometry/arc"), degrees: true }
    ],
    build: (v: any) =>
      new THREE.TorusGeometry(
        v.radius,
        v.tube,
        v.radialSegments,
        v.tubularSegments,
        v.arc * DEG2RAD
      )
  },
  TorusKnotGeometry: {
    fields: [
      { key: "radius", label: t("sidebar/geometry/torusKnot_geometry/radius") },
      { key: "tube", label: t("sidebar/geometry/torusKnot_geometry/tube") },
      {
        key: "tubularSegments",
        label: t("sidebar/geometry/torusKnot_geometry/tubularsegments"),
        integer: true,
        min: 1
      },
      {
        key: "radialSegments",
        label: t("sidebar/geometry/torusKnot_geometry/radialsegments"),
        integer: true,
        min: 1
      },
      { key: "p", label: t("sidebar/geometry/torusKnot_geometry/p"), integer: true },
      { key: "q", label: t("sidebar/geometry/torusKnot_geometry/q"), integer: true }
    ],
    build: (v: any) =>
      new THREE.TorusKnotGeometry(
        v.radius,
        v.tube,
        v.tubularSegments,
        v.radialSegments,
        v.p,
        v.q
      )
  }
}

for (const type of ["Dodecahedron", "Icosahedron", "Octahedron", "Tetrahedron"]) {
  const prefix = type.toLowerCase() + "_geometry"
  configs[`${type}Geometry`] = {
    fields: [
      { key: "radius", label: t(`sidebar/geometry/${prefix}/radius`) },
      {
        key: "detail",
        label: t(`sidebar/geometry/${prefix}/detail`),
        integer: true,
        min: 0
      }
    ],
    build: (v: any) => new (THREE as any)[`${type}Geometry`](v.radius, v.detail)
  }
}

const values = reactive<Record<string, number | boolean>>({})

const config = computed(() => configs[props.object?.geometry?.type])

function refresh() {
  const cfg = config.value
  const parameters = props.object?.geometry?.parameters
  if (!cfg || !parameters) return

  for (const field of cfg.fields) {
    const raw = parameters[field.key]
    values[field.key] = field.degrees ? raw * RAD2DEG : raw
  }
}

function update() {
  const cfg = config.value
  if (!cfg) return

  const args: Record<string, any> = {}
  for (const field of cfg.fields) {
    args[field.key] = field.degrees ? Number(values[field.key]) * DEG2RAD : values[field.key]
  }

  editor.execute(new SetGeometryCommand(editor, props.object, cfg.build(args)))
}

watch(
  () => props.object,
  () => refresh(),
  { immediate: true }
)

defineExpose({ refresh })
</script>

<template>
  <div v-if="config" class="space-y-2">
    <div v-for="field in config.fields" :key="field.key" class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{ field.label }}</Label>

      <Checkbox
        v-if="field.boolean"
        v-model="values[field.key]"
        @update:model-value="update"
      />
      <NumberField
        v-else
        v-model="values[field.key]"
        :min="field.min"
        class="w-24"
        @update:model-value="update"
      >
        <NumberFieldContent>
          <NumberFieldDecrement v-if="field.integer" />
          <NumberFieldInput class="h-7 text-xs" />
          <NumberFieldIncrement v-if="field.integer" />
        </NumberFieldContent>
      </NumberField>
    </div>
  </div>
</template>
