<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import {
  Camera,
  Move,
  Redo2,
  RotateCw,
  Scaling,
  Trash2,
  Undo2,
  UserPlus
} from "lucide-vue-next"
import * as THREE from "three"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { AddObjectCommand } from "@/components/three-editor/commands/AddObjectCommand"
import { useDirectorHistory } from "./useDirectorHistory"

const editor = useEditor()
const signals = editor.signals
const { canUndo, canRedo, undo, redo } = useDirectorHistory(editor)

const modes = [
  { value: "translate", label: "移动", icon: Move },
  { value: "rotate", label: "旋转", icon: RotateCw },
  { value: "scale", label: "缩放", icon: Scaling }
] as const

const mode = ref<(typeof modes)[number]["value"]>("translate")
const hasSelection = ref(!!editor.selected)

function onModeChanged(newMode: (typeof modes)[number]["value"]) {
  mode.value = newMode
}

function onSelectionChanged(object: any) {
  hasSelection.value = !!object
}

function onModeSelect(value: any) {
  signals.transformModeChanged.dispatch(value)
}

onMounted(() => {
  signals.transformModeChanged.add(onModeChanged)
  signals.objectSelected.add(onSelectionChanged)
})

onBeforeUnmount(() => {
  signals.transformModeChanged.remove(onModeChanged)
  signals.objectSelected.remove(onSelectionChanged)
})

function nextName(prefix: string) {
  let index = 1
  const taken = new Set(editor.scene.children.map((object: any) => object.name))
  while (taken.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}

function addCharacter() {
  const group = new THREE.Group()
  group.name = nextName("角色")
  group.userData.isCharacter = true

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x4f7dff })
  )
  body.position.y = 1
  group.add(body)

  editor.execute(new AddObjectCommand(editor, group))
}

function addCameraPosition() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
  camera.name = nextName("机位")
  camera.position.set(0, 2, 5)

  editor.execute(new AddObjectCommand(editor, camera))
}

function clearScene() {
  if (!window.confirm("清空当前场景？此操作无法撤销。")) return
  editor.clear()
}
</script>

<template>
  <div
    class="te-toolbar flex items-center gap-1 rounded-md border bg-card p-1 shadow-sm"
  >
    <TooltipProvider :delay-duration="300">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!canUndo"
            @click="undo"
          >
            <Undo2 class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>撤销</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!canRedo"
            @click="redo"
          >
            <Redo2 class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>重做</TooltipContent>
      </Tooltip>
    </TooltipProvider>

    <Separator orientation="vertical" class="h-6" />

    <Select
      :model-value="mode"
      :disabled="!hasSelection"
      @update:model-value="onModeSelect"
    >
      <SelectTrigger size="sm" class="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="item in modes" :key="item.value" :value="item.value">
          <span class="flex items-center gap-2">
            <component :is="item.icon" class="size-3.5" />
            {{ item.label }}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>

    <Separator orientation="vertical" class="h-6" />

    <Button variant="ghost" size="sm" @click="addCharacter">
      <UserPlus class="size-4" />
      添加角色
    </Button>

    <Button variant="ghost" size="sm" @click="addCameraPosition">
      <Camera class="size-4" />
      添加机位
    </Button>

    <Separator orientation="vertical" class="h-6" />

    <TooltipProvider :delay-duration="300">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" @click="clearScene">
            <Trash2 class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>清空场景</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</template>
