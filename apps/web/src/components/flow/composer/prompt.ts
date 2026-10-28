import { defineNodeMode } from "@/components/flow/node-kit/protocol"

/**
 * 底部输入框（REQ-NODEKIT §6.1）的协议那一半：编辑模式 + 提交事件。
 *
 * 输入框是**按类型注册**的（类型声明的 `parts` / `modes`），不是通用能力 —— 哪些类型有、框里放什么都因类型而异。
 * 各类型的输入框共用 `PromptComposer.vue` 这个外壳组件；那是普通的组件复用，不进注册表。
 */

declare module "@/components/flow/node-kit/protocol" {
  interface FlowNodeEventMap {
    /**
     * 在底部输入框里按了回车。`text` 是提交时框里的内容（已经写回文档）。
     * 发的一方不知道谁在听：带 `runnable` 的节点由它接住、转成运行请求。
     */
    "composer:submit": { text: string }
  }
}

/** 正在底部输入框里写字：露出输入框（失去单选也不收），收起上方的工具条（两块浮层别同时挡着节点） */
export const EDIT_PROMPT_MODE = "edit-prompt"

export const editPromptMode = defineNodeMode({
  id: EDIT_PROMPT_MODE,
  reveal: ["composer"],
  conceal: ["toolbar"]
})
