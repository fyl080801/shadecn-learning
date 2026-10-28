<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import * as THREE from "three"

import { useEditor } from "./composables/useEditorContext"
import { getBindPoseBone } from "./SkeletonBindPose"

import { SetPositionCommand } from "./commands/SetPositionCommand"
import { SetRotationCommand } from "./commands/SetRotationCommand"
import { SetScaleCommand } from "./commands/SetScaleCommand"
import { MultiCmdsCommand } from "./commands/MultiCmdsCommand"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  NumberField,
  NumberFieldContent,
  NumberFieldInput
} from "@/components/ui/number-field"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const skinnedMesh = ref<any>(null)
const selectedBone = ref<any>(null)
const selectedBoneUuid = ref<string | null>(null)
const boneRows = ref<Array<{ bone: any; depth: number }>>([])

const rotationX = ref(0)
const rotationY = ref(0)
const rotationZ = ref(0)

function findSkinnedMesh(object: any) {
  if (!object) return null
  if (object.isSkinnedMesh) return object

  if (object.isBone) {
    let found: any = null

    editor.scene.traverse(function (child: any) {
      if (
        !found &&
        child.isSkinnedMesh &&
        child.skeleton?.bones.includes(object)
      ) {
        found = child
      }
    })

    return found
  }

  return null
}

function buildBoneRows(mesh: any) {
  const bones = mesh.skeleton.bones
  const boneSet = new Set(bones)
  const rows: Array<{ bone: any; depth: number }> = []

  function walk(bone: any, depth: number) {
    rows.push({ bone, depth })

    for (const child of bone.children) {
      if (boneSet.has(child)) walk(child, depth + 1)
    }
  }

  for (const bone of bones) {
    if (!boneSet.has(bone.parent)) walk(bone, 0)
  }

  return rows
}

function refreshBones() {
  boneRows.value = skinnedMesh.value ? buildBoneRows(skinnedMesh.value) : []
}

function syncRotationFromBone(bone: any) {
  rotationX.value = bone.rotation.x * THREE.MathUtils.RAD2DEG
  rotationY.value = bone.rotation.y * THREE.MathUtils.RAD2DEG
  rotationZ.value = bone.rotation.z * THREE.MathUtils.RAD2DEG
}

function onObjectSelected(object: any) {
  const mesh = findSkinnedMesh(object)

  if (mesh !== skinnedMesh.value) {
    skinnedMesh.value = mesh
    refreshBones()
  }

  if (object?.isBone) {
    selectedBone.value = object
    selectedBoneUuid.value = object.uuid
    syncRotationFromBone(object)
  } else {
    selectedBone.value = null
    selectedBoneUuid.value = null
  }
}

function onObjectChanged(object: any) {
  if (skinnedMesh.value && object === skinnedMesh.value) refreshBones()
  if (object === selectedBone.value) syncRotationFromBone(object)
}

function selectBone(bone: any) {
  editor.select(bone)
}

// 旋转是关节唯一暴露的参数：平移或缩放骨骼会使其偏离父级并明显破坏
// 关节连接，而旋转只是围绕固定枢轴重新定向骨骼（及其下游的所有内容），
// 与真实骨骼的摆姿方式一致。
function updateRotation() {
  const bone = selectedBone.value
  if (!bone) return

  const newRotation = new THREE.Euler(
    rotationX.value * THREE.MathUtils.DEG2RAD,
    rotationY.value * THREE.MathUtils.DEG2RAD,
    rotationZ.value * THREE.MathUtils.DEG2RAD,
    bone.rotation.order
  )

  const delta = new THREE.Vector3()
    .setFromEuler(bone.rotation)
    .distanceTo(new THREE.Vector3().setFromEuler(newRotation))

  if (delta >= 1e-4) {
    editor.execute(new SetRotationCommand(editor, bone, newRotation))
  }
}

function resetJoint() {
  const bone = selectedBone.value
  if (!bone) return

  const bind = getBindPoseBone(bone)
  if (!bind) return

  const bindRotation = new THREE.Euler().setFromQuaternion(
    bind.quaternion,
    bone.rotation.order
  )

  editor.execute(new SetRotationCommand(editor, bone, bindRotation))
}

function resetPose() {
  if (!skinnedMesh.value) return

  const commands: any[] = []

  for (const bone of skinnedMesh.value.skeleton.bones) {
    const bind = getBindPoseBone(bone)
    if (!bind) continue

    if (bone.position.distanceTo(bind.position) >= 1e-5) {
      commands.push(new SetPositionCommand(editor, bone, bind.position))
    }

    const bindRotation = new THREE.Euler().setFromQuaternion(
      bind.quaternion,
      bone.rotation.order
    )
    const rotationDelta = new THREE.Vector3()
      .setFromEuler(bone.rotation)
      .distanceTo(new THREE.Vector3().setFromEuler(bindRotation))
    if (rotationDelta >= 1e-5) {
      commands.push(new SetRotationCommand(editor, bone, bindRotation))
    }

    if (bone.scale.distanceTo(bind.scale) >= 1e-5) {
      commands.push(new SetScaleCommand(editor, bone, bind.scale))
    }
  }

  if (commands.length > 0) {
    editor.execute(new MultiCmdsCommand(editor, commands))
  }
}

onMounted(() => {
  onObjectSelected(editor.selected)

  signals.objectSelected.add(onObjectSelected)
  signals.objectChanged.add(onObjectChanged)
  signals.sceneGraphChanged.add(refreshBones)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(onObjectSelected)
  signals.objectChanged.remove(onObjectChanged)
  signals.sceneGraphChanged.remove(refreshBones)
})
</script>

<template>
  <div v-if="skinnedMesh" class="te-sidebar-skeleton space-y-2 p-3">
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium text-muted-foreground">
        {{ t("sidebar/skeleton/bones") }}
      </span>
      <Button
        variant="outline"
        size="sm"
        class="h-7 text-xs"
        @click="resetPose"
      >
        {{ t("sidebar/skeleton/resetPose") }}
      </Button>
    </div>

    <div class="space-y-0.5">
      <button
        v-for="row in boneRows"
        :key="row.bone.uuid"
        type="button"
        class="flex w-full items-center rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
        :class="{
          'bg-accent text-accent-foreground': row.bone.uuid === selectedBoneUuid
        }"
        :style="{ paddingLeft: 6 + row.depth * 14 + 'px' }"
        @click="selectBone(row.bone)"
      >
        {{ row.bone.name || "Bone" }}
      </button>
    </div>

    <div v-if="selectedBone" class="space-y-2 border-t pt-2">
      <div class="flex items-center justify-between">
        <span class="truncate text-xs font-medium">{{
          selectedBone.name || "Bone"
        }}</span>
        <Button
          variant="outline"
          size="sm"
          class="h-7 text-xs"
          @click="resetJoint"
        >
          {{ t("sidebar/skeleton/resetJoint") }}
        </Button>
      </div>

      <div class="flex items-center gap-2">
        <Label class="w-16 shrink-0 text-xs">{{
          t("sidebar/object/rotation")
        }}</Label>
        <div class="grid flex-1 grid-cols-3 gap-1">
          <NumberField
            v-model="rotationX"
            :step="10"
            @update:model-value="updateRotation"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="rotationY"
            :step="10"
            @update:model-value="updateRotation"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
          <NumberField
            v-model="rotationZ"
            :step="10"
            @update:model-value="updateRotation"
          >
            <NumberFieldContent>
              <NumberFieldInput class="h-7 text-xs" />
            </NumberFieldContent>
          </NumberField>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="te-sidebar-skeleton p-3 text-xs text-muted-foreground">
    {{ t("sidebar/skeleton/empty") }}
  </div>
</template>
