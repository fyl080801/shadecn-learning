import { onBeforeUnmount, onMounted, type Ref } from "vue"

export function useEditorDragDrop(editor: any, containerRef: Ref<HTMLElement | null>) {
  function onDragover(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    if (!e.dataTransfer) return
    if (e.dataTransfer.types[0] === "text/plain") return
    if (e.dataTransfer.items) editor.loader.loadItemList(e.dataTransfer.items)
    else editor.loader.loadFiles(e.dataTransfer.files)
  }

  onMounted(() => {
    containerRef.value?.addEventListener("dragover", onDragover)
    containerRef.value?.addEventListener("drop", onDrop)
  })

  onBeforeUnmount(() => {
    containerRef.value?.removeEventListener("dragover", onDragover)
    containerRef.value?.removeEventListener("drop", onDrop)
  })
}
