import { onBeforeUnmount, onMounted, ref } from "vue"

// The three-editor vendor code only wires up Cmd/Ctrl+Z and the undo/redo
// actions inside SidebarSettings.vue (its keyboard-shortcut handler) and
// EditorMenubar.vue (its Edit menu) — the director console mounts neither,
// so `editor.history` was reachable but nothing ever called undo()/redo().
// This gives the toolbar buttons and the standard keyboard shortcut without
// pulling in the rest of the settings/menubar UI.
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
