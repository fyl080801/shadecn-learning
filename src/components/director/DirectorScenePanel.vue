<script setup lang="ts">
// @ts-nocheck
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { Eye, EyeOff, Lock, Unlock } from "lucide-vue-next"

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
  signals.objectSelected.add(onObjectSelected)
})

onBeforeUnmount(() => {
  signals.sceneGraphChanged.remove(bump)
  signals.objectSelected.remove(onObjectSelected)
})

// Flat, ungrouped list of top-level scene graphics — the panorama sphere
// (see DirectorScenePropertiesPanel) lives in editor.backdrop, not
// editor.scene, so it never appears here.
//
// Three.js mutates `scene.children` in place (push/splice), so it's always
// the same array reference. A computed that returned it directly would
// recompute on every bump() but Vue would see the "new" result as
// reference-equal to the cached one and skip re-rendering the v-for below —
// copying into a fresh array each time is what makes the bump visible.
const items = computed(() => {
  graphVersion.value
  return [...editor.scene.children]
})

function selectItem(object: any) {
  if (object.userData?.locked) return
  editor.select(object)
}

function toggleVisible(object: any, event: Event) {
  event.stopPropagation()
  editor.execute(
    new SetValueCommand(editor, object, "visible", !object.visible)
  )
}

function toggleLock(object: any, event: Event) {
  event.stopPropagation()
  object.userData.locked = !object.userData.locked

  if (object.userData.locked && editor.selected === object) {
    editor.deselect()
  }

  signals.sceneGraphChanged.dispatch()
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
          class="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
          :class="[
            selectedUuid === object.uuid
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/50',
            object.userData?.locked ? 'opacity-50' : 'cursor-pointer'
          ]"
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
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-6"
            @click="toggleLock(object, $event)"
          >
            <component
              :is="object.userData?.locked ? Lock : Unlock"
              class="size-3.5"
            />
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
