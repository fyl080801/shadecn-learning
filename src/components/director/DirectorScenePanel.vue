<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { Eye, EyeOff } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import { SetValueCommand } from "@/components/three-editor/commands/SetValueCommand"

const editor = useEditor()
const signals = editor.signals

const graphVersion = ref(0)
const selectedUuid = ref<string | null>(editor.selected?.uuid ?? null)

function bump() {
  graphVersion.value++
}

function onObjectSelected(object: any) {
  selectedUuid.value = object ? object.uuid : null
}

onMounted(() => {
  signals.sceneGraphChanged.add(bump)
  // editor.clear()（工具栏的"清空场景"）在移除对象期间会抑制 sceneGraphChanged，
  // 仅在之后分发 editorCleared，因此若无此监听器，此处的列表将继续显示
  // 已被移除的对象。
  signals.editorCleared.add(bump)
  signals.objectSelected.add(onObjectSelected)
})

onBeforeUnmount(() => {
  signals.sceneGraphChanged.remove(bump)
  signals.editorCleared.remove(bump)
  signals.objectSelected.remove(onObjectSelected)
})

// 顶层场景图形的扁平、未分组列表——全景天空球
// （见 DirectorScenePropertiesPanel）位于 editor.backdrop 而非
// editor.scene 中，因此永远不会出现在这里。
//
// Three.js 就地修改 `scene.children`（push/splice），因此它始终是
// 同一个数组引用。若 computed 直接返回它，每次 bump() 时会重新计算，
// 但 Vue 会将"新"结果视为与缓存结果引用相等而跳过下方 v-for 的重新渲染——
// 每次复制到新数组才能使 bump 生效。
const items = computed(() => {
  graphVersion.value
  return [...editor.scene.children]
})

function selectItem(object: any) {
  editor.select(object)
}

function toggleVisible(object: any, event: Event) {
  event.stopPropagation()
  editor.execute(
    new SetValueCommand(editor, object, "visible", !object.visible)
  )
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
      场景
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col gap-0.5 p-1">
        <div
          v-for="object in items"
          :key="object.uuid"
          class="group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm"
          :class="
            selectedUuid === object.uuid
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/50'
          "
          @click="selectItem(object)"
        >
          <span class="min-w-0 flex-1 truncate">{{
            object.name || object.type
          }}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-6"
            @click="toggleVisible(object, $event)"
          >
            <component :is="object.visible ? Eye : EyeOff" class="size-3.5" />
          </Button>
        </div>

        <div
          v-if="items.length === 0"
          class="px-2 py-6 text-center text-xs text-muted-foreground"
        >
          暂无图形，点击下方工具栏添加角色或机位
        </div>
      </div>
    </ScrollArea>
  </div>
</template>
