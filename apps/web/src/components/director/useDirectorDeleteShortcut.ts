import { onBeforeUnmount, onMounted } from "vue"

import { RemoveObjectCommand } from "@/components/three-editor/commands/RemoveObjectCommand"

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA"
}

// 厂商的 Delete/Backspace 处理逻辑位于 SidebarSettings.vue 中，而导演控制台
// 不挂载该组件，因此在视口中按 Delete 没有任何反应——只能通过场景面板的
// 逐行操作来移除图形。通过 RemoveObjectCommand（而非直接调用
// editor.removeObject）来执行删除，可以保持撤销能力，并复用
// DirectorScenePanel 已监听的 sceneGraphChanged 信号，使左侧列表自动保持同步。
export function useDirectorDeleteShortcut(editor: any) {
  function onKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    if (key !== "delete" && key !== "backspace") return
    if (isEditableTarget(event.target)) return

    const object = editor.selected
    if (!object || object.parent === null) return

    if (key === "backspace") event.preventDefault() // 阻止浏览器后退

    editor.execute(new RemoveObjectCommand(editor, object))
  }

  onMounted(() => document.addEventListener("keydown", onKeydown))
  onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown))
}
