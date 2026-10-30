/**
 * 导演台节点「打开导演台」的事件声明（REQ-CANVAS §3.7、docs/07 §7.4）。
 *
 * 节点只负责发事件，谁打开、开成什么样由编辑器级的订阅方（`FlowDirectorOverlay.vue`）决定 ——
 * 节点不直接跳路由、不自己弹层（节点在 Vue Flow 的变换层里，弹出来的东西会跟着缩放、被节点层级压住）。
 * 发事件的节点就是要打开的那个，id 在事件源 `ctx.id` 上，载荷不再重复带。
 *
 * 两个发出方：body 的「打开导演台」按钮（不带 `prompt`），和能力 `director-chat`（底部输入框回车，带 `prompt`：
 * 打开后在导演台里的当前会话发出这条消息，开头已经补上了这个节点的提及）。
 */

declare module "@/components/flow/node-kit/protocol" {
  interface FlowNodeEventMap {
    "director:open": {
      /** 打开之后要在导演台里的当前会话发出去的消息（节点底部输入框来的，开头带着这个节点的提及） */
      prompt?: string
    }
  }
}

export const DIRECTOR_OPEN_EVENT = "director:open"
