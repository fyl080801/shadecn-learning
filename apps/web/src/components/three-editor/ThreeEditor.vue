<script setup lang="ts">
import { ref } from "vue"

import { provideEditor } from "./composables/useEditorContext"
import { useEditorDragDrop } from "./composables/useEditorDragDrop"
import { useEditorWindowResize } from "./composables/useEditorWindowResize"

const props = defineProps<{ editor: any }>()

const containerRef = ref<HTMLDivElement | null>(null)

window.URL = window.URL || (window as any).webkitURL

provideEditor(props.editor)
// 不接入 useEditorAutosave：唯一消费方 DirectorConsoleModal.vue 已自行实现
// 场景持久化（写回画布节点 data.scene，见其 hydrateScene/saveState），若再叠加
// IndexedDB 自动保存，两条链路会各自对同一个新建 Editor 调用一次 fromJSON，
// 而 Editor.setScene() 是往场景里追加而非先清空，导致每个对象都被加载两份。
useEditorDragDrop(props.editor, containerRef)
useEditorWindowResize(props.editor, containerRef)
</script>

<template>
  <div
    ref="containerRef"
    class="te flex h-full w-full flex-col overflow-hidden"
  >
    <slot />
  </div>
</template>
