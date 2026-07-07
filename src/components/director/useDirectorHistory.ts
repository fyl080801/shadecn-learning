import { onBeforeUnmount, onMounted, ref } from "vue"

// three-editor 厂商代码仅在 SidebarSettings.vue（其键盘快捷键处理器）和
// EditorMenubar.vue（其编辑菜单）中接入了 Cmd/Ctrl+Z 及撤销/重做操作——导演控制台
// 不挂载这两个组件，因此 `editor.history` 虽可访问，却没有任何地方调用 undo()/redo()。
// 此处为工具栏按钮和标准键盘快捷键提供支持，而无需引入其余设置/菜单栏 UI。
export function useDirectorHistory(editor: any) {
  const signals = editor.signals
  const history = editor.history

  const canUndo = ref(history.undos.length > 0)
  const canRedo = ref(history.redos.length > 0)

  function refresh() {
    canUndo.value = history.undos.length > 0
    canRedo.value = history.redos.length > 0
  }

  function undo() {
    editor.undo()
  }

  function redo() {
    editor.redo()
  }

  const isMac = navigator.platform.toUpperCase().includes("MAC")

  function onKeydown(event: KeyboardEvent) {
    if (event.key.toLowerCase() !== "z") return
    if (isMac ? !event.metaKey : !event.ctrlKey) return

    event.preventDefault()
    if (event.shiftKey) {
      redo()
    } else {
      undo()
    }
  }

  onMounted(() => {
    signals.historyChanged.add(refresh)
    document.addEventListener("keydown", onKeydown)
  })

  onBeforeUnmount(() => {
    signals.historyChanged.remove(refresh)
    document.removeEventListener("keydown", onKeydown)
  })

  return { canUndo, canRedo, undo, redo }
}
