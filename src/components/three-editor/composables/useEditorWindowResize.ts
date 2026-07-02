import { onBeforeUnmount, onMounted, type Ref } from "vue"

export function useEditorWindowResize(editor: any, containerRef: Ref<HTMLElement | null>) {
  let resizeObserver: ResizeObserver | null = null

  function onResize() {
    editor.signals.windowResize.dispatch()
  }

  onMounted(() => {
    window.addEventListener("resize", onResize)

    resizeObserver = new ResizeObserver(() => {
      editor.signals.windowResize.dispatch()
    })
    if (containerRef.value) resizeObserver.observe(containerRef.value)

    editor.signals.windowResize.dispatch()
  })

  onBeforeUnmount(() => {
    window.removeEventListener("resize", onResize)
    resizeObserver?.disconnect()
  })
}
