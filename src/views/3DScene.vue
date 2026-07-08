<script setup lang="ts">
import { onMounted } from "vue"

import {
  createEditor,
  ThreeEditor,
  EditorViewport
  // EditorViewportInfo
} from "@/components/three-editor"
import DirectorViewTabs from "@/components/director/DirectorViewTabs.vue"
import DirectorScenePanel from "@/components/director/DirectorScenePanel.vue"
import DirectorToolbar from "@/components/director/DirectorToolbar.vue"
import DirectorScenePropertiesPanel from "@/components/director/DirectorScenePropertiesPanel.vue"
import DirectorObjectPropertiesPanel from "@/components/director/DirectorObjectPropertiesPanel.vue"
import DirectorCameraPropertiesPanel from "@/components/director/DirectorCameraPropertiesPanel.vue"
import { useCameraLookAt } from "@/components/director/cameraLookAt"
import { useCameraFrustumFootprint } from "@/components/director/useCameraFrustumFootprint"
import DirectorCharacterLabels from "@/components/director/DirectorCharacterLabels.vue"
import { useDirectorRenderer } from "@/components/director/useDirectorRenderer"
import { useDirectorDeleteShortcut } from "@/components/director/useDirectorDeleteShortcut"
import { useCharacterUnlitMaterial } from "@/components/director/useCharacterUnlitMaterial"
import { useCharacterSkeletonOverlay } from "@/components/director/useCharacterSkeletonOverlay"
import { useCameraModelVisibility } from "@/components/director/useCameraModelVisibility"

const editor = createEditor("director-console")

useDirectorDeleteShortcut(editor)
useCharacterUnlitMaterial(editor)
useCharacterSkeletonOverlay(editor)
useCameraModelVisibility(editor)
useCameraLookAt(editor)
useCameraFrustumFootprint(editor)

onMounted(() => {
  useDirectorRenderer(editor)
})
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
          <EditorViewport
            class="absolute inset-0"
            :view-helper-offset="{ top: 0, right: 0 }"
          />
          <DirectorCharacterLabels />
          <DirectorToolbar
            class="absolute bottom-4 left-1/2 -translate-x-1/2"
          />
          <!-- <EditorViewportInfo class="absolute left-[10px] z-10" /> -->
        </main>

        <aside class="w-72 shrink-0 border-l bg-card">
          <DirectorScenePropertiesPanel />
          <DirectorObjectPropertiesPanel />
          <DirectorCameraPropertiesPanel />
        </aside>
      </div>
    </div>
  </ThreeEditor>
</template>
