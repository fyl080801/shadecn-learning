<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue"

import { createEditor, ThreeEditor, EditorViewport } from "@/components/three-editor"
import DirectorViewTabs from "@/components/director/DirectorViewTabs.vue"
import DirectorScenePanel from "@/components/director/DirectorScenePanel.vue"
import DirectorToolbar from "@/components/director/DirectorToolbar.vue"
import DirectorScenePropertiesPanel from "@/components/director/DirectorScenePropertiesPanel.vue"
import DirectorObjectPropertiesPanel from "@/components/director/DirectorObjectPropertiesPanel.vue"
import DirectorCharacterLabels from "@/components/director/DirectorCharacterLabels.vue"
import { useDirectorRenderer } from "@/components/director/useDirectorRenderer"

const editor = createEditor("director-console")

// A locked graphic must not be selectable/draggable in the viewport — the
// scene panel already skips select() for locked rows, but objects can also
// be picked by clicking directly in the 3D viewport, so enforce it here too.
function enforceLock(object: any) {
  if (object?.userData?.locked) editor.deselect()
}

onMounted(() => {
  editor.signals.objectSelected.add(enforceLock)
  useDirectorRenderer(editor)
})
onBeforeUnmount(() => editor.signals.objectSelected.remove(enforceLock))
</script>

<template>
  <ThreeEditor :editor="editor">
    <div class="flex h-full w-full flex-col overflow-hidden">
      <header
        class="flex h-12 shrink-0 items-center justify-between border-b bg-card px-4"
      >
        <span class="text-sm font-semibold">3D导演台</span>
        <DirectorViewTabs />
        <span class="w-24" />
      </header>

      <div class="flex min-h-0 flex-1">
        <aside class="w-56 shrink-0 border-r bg-card">
          <DirectorScenePanel />
        </aside>

        <main class="relative min-w-0 flex-1 bg-background">
          <EditorViewport class="absolute inset-0" />
          <DirectorCharacterLabels />
          <DirectorToolbar class="absolute bottom-4 left-1/2 -translate-x-1/2" />
        </main>

        <aside class="w-72 shrink-0 border-l bg-card">
          <DirectorScenePropertiesPanel />
          <DirectorObjectPropertiesPanel />
        </aside>
      </div>
    </div>
  </ThreeEditor>
</template>
