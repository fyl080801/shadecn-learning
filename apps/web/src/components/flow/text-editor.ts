/**
 * 文本节点「独立编辑」的事件声明（docs/13 §3.7、docs/21 §4.10）。
 *
 * 节点只负责发事件（右上角的按钮），编辑器级的独立编辑层宿主（`overlay/FlowNodeOverlayHost.vue`）接住、
 * 盖一层 backdrop 打开文本编辑面板（`TextEditorPanel.vue`）。发事件的节点就是要编辑的那个，id 在事件源 `ctx.id` 上。
 */

declare module "@/components/flow/node-kit/protocol" {
  interface FlowNodeEventMap {
    "text:open-editor": Record<string, never>
  }
}

export const TEXT_OPEN_EDITOR_EVENT = "text:open-editor"
