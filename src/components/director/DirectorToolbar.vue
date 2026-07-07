<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import {
  Box,
  Camera,
  Circle,
  Cone,
  Cylinder,
  Move,
  PersonStanding,
  Pyramid,
  Redo2,
  RotateCw,
  Scaling,
  Torus,
  Trash2,
  Undo2,
  Upload,
  UserPlus
} from "lucide-vue-next"
import * as THREE from "three"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { AddObjectCommand } from "@/components/three-editor/commands/AddObjectCommand"
import { applyFBXUnitScale } from "@/components/three-editor/Loader"
import { snapshotBindPose } from "@/components/three-editor/SkeletonBindPose"
import { applyUnlitCharacterMaterial } from "./characterPose"
import { useDirectorHistory } from "./useDirectorHistory"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import xBotUrl from "@/assets/X Bot.fbx?url"
import yBotUrl from "@/assets/Y Bot.fbx?url"

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

const currentModeIcon = computed(
  () => modes.find((item) => item.value === mode.value)?.icon
)

function onModeChanged(newMode: (typeof modes)[number]["value"]) {
  mode.value = newMode
}

function onModeSelect(value: (typeof modes)[number]["value"]) {
  signals.transformModeChanged.dispatch(value)
}

function onSelectionChanged(object: any) {
  hasSelection.value = !!object
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

const characterPresets = [
  { label: "男性素体", icon: PersonStanding, url: yBotUrl },
  { label: "女性素体", icon: PersonStanding, url: xBotUrl }
] as const

// 每次点击时延迟加载（与 Loader.ts 对同一模块的动态导入一致），
// 而非在模块作用域一次性加载，使工具栏不会将 FBXLoader 引入
// 导演控制台的初始打包中。
async function addCharacterPreset(item: (typeof characterPresets)[number]) {
  const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js")
  const loader = new FBXLoader()

  loader.load(item.url, async (object: any) => {
    // FBXLoader 将 Mixamo/Blender 导出文件的单位元数据报告为
    // "原始数值即厘米"，因此 applyFBXUnitScale 会将 object.scale 设为
    // 0.01（正确的真实尺寸，约 1.8m 高），而非用户在面板中期望看到的
    // 角色"自然"缩放值 1.0——而 Blender 的 FBX 导出器无条件烘焙该厘米约定，
    // 因此无法通过重新导出来修正（已验证：apply_unit_scale 和导出前的
    // "Apply Scale" 均无法改变）。将解析内容包裹在普通 Group 中可将该 0.01
    // 完全内部化——被选中/添加/编辑的是包裹器，其自身缩放从 Object3D
    // 默认值 (1,1,1) 开始。
    applyFBXUnitScale(object)
    await snapshotBindPose(object)

    // 见 characterPose.ts 中 applyUnlitCharacterMaterial 的说明。
    applyUnlitCharacterMaterial(object)

    const wrapper = new THREE.Group()
    wrapper.add(object)
    wrapper.name = nextName(item.label)
    // Selector.ts 将视口中点击角色任意部分（网格、骨骼）的事件冒泡
    // 到最近的带有 isCharacter 标记的祖先节点，而 DirectorCharacterLabels.vue
    // 仅在带有此标记的对象上方浮动名称标签——若无此标记，点击模型会选中
    // 射线检测命中的子网格而非此包裹器，因此拖拽只会移动角色的一部分
    // 而非整个角色。
    wrapper.userData.isCharacter = true
    editor.execute(new AddObjectCommand(editor, wrapper))
    editor.focus(wrapper)
  })
}

const geometryPresets = [
  { label: "上传文件", icon: Upload, geometry: null },
  {
    label: "立方体",
    icon: Box,
    geometry: () => new THREE.BoxGeometry(1, 1, 1)
  },
  {
    label: "球体",
    icon: Circle,
    geometry: () => new THREE.SphereGeometry(0.5, 32, 16)
  },
  {
    label: "圆柱体",
    icon: Cylinder,
    geometry: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
  },
  {
    label: "环状体",
    icon: Torus,
    geometry: () => new THREE.TorusGeometry(0.5, 0.2, 16, 48)
  },
  {
    label: "圆锥",
    icon: Cone,
    geometry: () => new THREE.ConeGeometry(0.5, 1, 32)
  },
  {
    label: "棱锥",
    icon: Pyramid,
    geometry: () => new THREE.ConeGeometry(0.5, 1, 4)
  }
] as const

function addGeometryPreset(item: (typeof geometryPresets)[number]) {
  if (!item.geometry) return

  const mesh = new THREE.Mesh(
    item.geometry(),
    new THREE.MeshStandardMaterial({ color: 0x9aa5b1 })
  )
  mesh.name = nextName(item.label)
  editor.execute(new AddObjectCommand(editor, mesh))
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

    <!-- <Select
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
    </Select> -->
    <TooltipProvider :delay-duration="300">
      <Tooltip>
        <DropdownMenu>
          <TooltipTrigger as-child>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :disabled="!hasSelection">
                <component :is="currentModeIcon" class="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <DropdownMenuContent
            align="start"
            class="flex w-auto min-w-0 gap-0.5 p-1"
          >
            <DropdownMenuItem
              v-for="item in modes"
              :key="item.value"
              :title="item.label"
              class="justify-center p-1.5"
              :class="mode === item.value && 'bg-accent text-accent-foreground'"
              @click="onModeSelect(item.value)"
            >
              <component :is="item.icon" class="size-4" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipContent>变换模式</TooltipContent>
      </Tooltip>
    </TooltipProvider>

    <Separator orientation="vertical" class="h-6" />

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="sm">
          <UserPlus class="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-44">
        <DropdownMenuItem>
          <Upload class="size-4" />
          本地上传
        </DropdownMenuItem>
        <DropdownMenuItem
          v-for="item in characterPresets"
          :key="item.label"
          @click="addCharacterPreset(item)"
        >
          <component :is="item.icon" class="size-4" />
          {{ item.label }}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Box class="size-4" />
            几何模型
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              v-for="item in geometryPresets"
              :key="item.label"
              @click="addGeometryPreset(item)"
            >
              <component :is="item.icon" class="size-4" />
              {{ item.label }}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>

    <Button variant="ghost" size="sm" @click="addCameraPosition">
      <Camera class="size-4" />
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
