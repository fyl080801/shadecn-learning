import { DIRECTOR_OPEN_EVENT } from "@/components/flow/director"

import { defineNodeFeature, defineNodeHandler } from "../protocol"

/**
 * 导演台的节点范围会话入口（docs/07 §7.4）：底部输入框回车（`composer:submit`）→ 转成带 `prompt` 的 `director:open`，
 * 由全屏层打开导演台、在绑定这个节点的会话里发出这条消息。
 *
 * 和 `runnable` 同一个形状：输入框只发 `composer:submit`，不知道谁在听；这个能力也不知道全屏层长什么样，
 * 只转一个事件。空文本不是一次请求（只是把框清空了）。
 */
export const directorChatFeature = defineNodeFeature({
  id: "director-chat",
  handlers: [
    defineNodeHandler({
      event: "composer:submit",
      handle: ({ text }, ctx) => {
        const prompt = text.trim()
        if (!prompt) return
        ctx.emit(DIRECTOR_OPEN_EVENT, { prompt })
      }
    })
  ]
})
