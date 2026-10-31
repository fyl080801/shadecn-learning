import { defineNodeFeature, defineNodeMode } from "@/components/flow/node-kit/protocol"

/**
 * 底部输入框（REQ-NODEKIT §6.1）的协议那一半：编辑模式 + 提交事件。
 *
 * 输入框部件是**按类型注册**的（类型声明的 `parts`，经 `composer-part.ts` 的 `definePromptComposerPart`），
 * 不是通用能力 —— 哪些类型有、框里放什么、什么时候收起都因类型而异。各类型的输入框共用 `PromptComposer.vue`
 * 这个外壳组件；那是普通的组件复用，不进注册表。
 *
 * 编辑模式却是**同一个**：模式 id 在注册表里全局唯一，不能每个类型各登记一份 `edit-prompt`。
 * 所以它打包成能力 `edit-prompt`（下面的 `editPromptFeature`，在 `install.ts` 登记），有输入框的类型在 `features` 里启用它。
 */

declare module "@/components/flow/node-kit/protocol" {
  interface FlowNodeEventMap {
    /**
     * 在底部输入框里按了发送（Shift+回车 / 发送按钮）。`text` 是提交时框里的内容（已经写回文档）。
     * 发的一方不知道谁在听：启用了 `runnable` 的类型由它接住、转成运行请求；
     * 眼下 text / image / video 都没启用，提交只是写回 `data.prompt`；director 启用了 `director-chat`：
     * 转成带 `prompt` 的 `director:open`，在绑定这个节点的会话里发出去（docs/07 §7.4）。
     */
    "composer:submit": { text: string }
  }
}

/** 正在底部输入框里写字：露出输入框（失去单选也不收）；上方的工具条照常显示，节点选中期间它一直在 */
export const EDIT_PROMPT_MODE = "edit-prompt"

export const editPromptMode = defineNodeMode({
  id: EDIT_PROMPT_MODE,
  reveal: ["composer"]
})

/** 有底部输入框的类型启用它：拿到 `edit-prompt` 模式（部件本身仍按类型注册） */
export const editPromptFeature = defineNodeFeature({
  id: "edit-prompt",
  modes: [editPromptMode]
})
