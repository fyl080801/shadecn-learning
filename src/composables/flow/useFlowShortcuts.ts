import { useEventListener } from "@vueuse/core"
import { onBeforeRouteLeave } from "vue-router"
import type { FlowEditorContext } from "./context"

/** 输入框里按 Ctrl+Z 应该是撤销输入，不是撤销画布操作 */
function isEditableTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
}

/**
 * 编辑器的全局快捷键与「别把没保存的改动弄丢」两道保险。
 * 只在编辑器根组件调用一次。
 */
export function useFlowShortcuts(context: FlowEditorContext) {
  const { store, selection, document: doc } = context

  useEventListener(window, "keydown", (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return

    const mod = event.metaKey || event.ctrlKey

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) store.redo()
      else store.undo()
      return
    }

    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void store.saveNow()
      return
    }

    if ((event.key === "Delete" || event.key === "Backspace") && selection.selectedNodeId.value) {
      event.preventDefault()
      selection.deleteSelection()
    }
  })

  // 还有没提交的就别让人悄悄关掉标签页
  useEventListener(window, "beforeunload", (event: BeforeUnloadEvent) => {
    if (!store.dirty) return
    event.preventDefault()
    event.returnValue = ""
  })

  // SPA 内部跳走同理：先把待提交的落库再放行
  onBeforeRouteLeave(async () => {
    await doc.flushBeforeLeave()
    return true
  })
}
