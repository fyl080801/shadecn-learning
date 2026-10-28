import { useEventListener } from "@vueuse/core"
import { onBeforeRouteLeave } from "vue-router"
import type { FlowEditorContext } from "./editor-context"
// 输入框里按 Ctrl+Z 应该是撤销输入，不是撤销画布操作
import { isEditableTarget } from "./editable"

/**
 * 编辑器的全局快捷键与「别把没保存的改动弄丢」两道保险。
 * 只在编辑器根组件调用一次。
 */
export function useFlowShortcuts(context: FlowEditorContext) {
  const { store, canvas, document: doc, selection, nodeKit } = context

  useEventListener(window, "keydown", (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return

    const mod = event.metaKey || event.ctrlKey

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) store.redo()
      else store.undo()
      return
    }

    // Ctrl+S 不再有「保存」的含义（改动即刻同步），但要拦住浏览器的保存网页对话框
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault()
      return
    }

    // 删除键由我们自己接（Vue Flow 那个已经关掉了）：它会绕过 store.apply，
    // 删掉的东西既不进历史也不落库、更不会同步给别人。节点和边都归这一条管。
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      canvas.deleteSelection()
      return
    }

    // 剩下的交给**单独选中**的那个节点上的动作（`defineNodeAction` 的 `shortcut`）。
    // 排在编辑器自己的那几条之后：节点动作抢不走撤销、删除这些全局键。
    // 多选时没有「当前节点」，节点动作的快捷键不生效 —— 和节点工具条只在单选时出现一致。
    const nodeId = selection.selectedNodeId.value
    if (nodeId && nodeKit.dispatchShortcut(nodeId, event)) event.preventDefault()
  })

  // SPA 内部跳走同理：先把待提交的落库再放行
  onBeforeRouteLeave(async () => {
    await doc.flushBeforeLeave()
    return true
  })
}
