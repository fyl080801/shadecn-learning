import TextEditorPanel from "@/components/flow/TextEditorPanel.vue"
import { TEXT_OPEN_EDITOR_EVENT } from "@/components/flow/text-editor"
import { defineNodePopup, type NodePopupDef } from "./node-popup"

/**
 * 所有弹出编辑的登记表（docs/21 §4.10）—— 宿主 `FlowNodePopupHost` 按这张表接打开事件。
 * 加一种 = 这里一条 + 一个内容组件 + 节点类型上一枚 `popupOpenPart` 入口。
 */
export const FLOW_NODE_POPUPS: readonly NodePopupDef[] = [
  /** 文本：编辑 Markdown 正文 + 实时预览 */
  defineNodePopup({
    id: "text-editor",
    event: TEXT_OPEN_EDITOR_EVENT,
    match: { types: ["text"] },
    component: TextEditorPanel,
    fallbackTitle: "文本"
  })
] as readonly NodePopupDef[]
