<script setup lang="ts">
import { ref } from "vue"

import {
  createEditor,
  ThreeEditor,
  EditorMenubar,
  EditorSidebar,
  EditorToolbar,
  EditorViewport,
  EditorPlayer,
  EditorScript,
  EditorAnimation,
  EditorResizer
} from "@/components/three-editor"

const SIDEBAR_DEFAULT_WIDTH = 350

const sidebarColRef = ref<HTMLDivElement | null>(null)

const editor = createEditor()
</script>

<template>
  <ThreeEditor :editor="editor">
    <EditorMenubar />

    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="relative min-h-0 flex-1">
          <EditorViewport />
          <EditorToolbar />
          <EditorPlayer />
          <EditorScript />
        </div>

        <EditorResizer direction="vertical" />
        <EditorAnimation />
      </div>

      <EditorResizer direction="horizontal" :sidebar-col-ref="sidebarColRef" />

      <div
        ref="sidebarColRef"
        class="h-full shrink-0"
        :style="{ width: SIDEBAR_DEFAULT_WIDTH + 'px' }"
      >
        <EditorSidebar />
      </div>
    </div>
  </ThreeEditor>
</template>
