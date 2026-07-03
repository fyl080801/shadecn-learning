<script setup lang="ts">
import {
  createEditor,
  ThreeEditor,
  EditorMenubar,
  EditorSidebar,
  EditorToolbar,
  EditorViewport,
  EditorPlayer,
  EditorScript,
  EditorAnimation
} from "@/components/three-editor"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from "@/components/ui/resizable"

const editor = createEditor()
</script>

<template>
  <ThreeEditor :editor="editor">
    <EditorMenubar />

    <ResizablePanelGroup direction="horizontal" class="min-h-0 flex-1">
      <ResizablePanel>
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel :default-size="80" :min-size="30">
            <div class="relative h-full min-h-0">
              <EditorViewport class="absolute inset-0" />
              <EditorToolbar
                class="absolute bottom-14 left-1/2 -translate-x-1/2"
              />
              <EditorPlayer class="absolute inset-0" />
              <EditorScript class="absolute inset-0" />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel :default-size="20" :min-size="10" :max-size="50">
            <EditorAnimation />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel :default-size="18" :min-size="18">
        <EditorSidebar />
      </ResizablePanel>
    </ResizablePanelGroup>
  </ThreeEditor>
</template>
