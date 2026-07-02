<script setup lang="ts">
import { ref } from "vue"

import { provideEditor } from "./composables/useEditorContext"
import { useEditorStylesheet } from "./composables/useEditorStylesheet"
import { useEditorAutosave } from "./composables/useEditorAutosave"
import { useEditorDragDrop } from "./composables/useEditorDragDrop"
import { useEditorWindowResize } from "./composables/useEditorWindowResize"

const props = defineProps<{ editor: any }>()

const containerRef = ref<HTMLDivElement | null>(null)

window.URL = window.URL || (window as any).webkitURL

provideEditor(props.editor)
useEditorStylesheet()
useEditorAutosave(props.editor)
useEditorDragDrop(props.editor, containerRef)
useEditorWindowResize(props.editor, containerRef)
</script>

<template>
  <div ref="containerRef" class="flex h-full w-full flex-col overflow-hidden">
    <slot />
  </div>
</template>
