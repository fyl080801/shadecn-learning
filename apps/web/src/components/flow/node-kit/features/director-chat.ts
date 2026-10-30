import { formatNodeMention, parseNodeMentions } from "@shadecn/shared/agent"
import { DIRECTOR_OPEN_EVENT } from "@/components/flow/director"

import { defineNodeFeature, defineNodeHandler } from "../protocol"

/**
 * 导演台节点底部输入框的会话入口（docs/07 §7.5）：回车（`composer:submit`）→ 转成带 `prompt` 的 `director:open`，
 * 由全屏层打开导演台、在那里的当前会话里发出这条消息。
 *
 * **消息开头补上这个节点的提及**（已经提及了就不重复，docs/20 §3.10.9）：会话是全局 agent，指定节点靠提及 ——
 * 提及让 agent 知道用户说的是哪个导演台，也让服务端自动加载导演台技能。
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
        ctx.emit(DIRECTOR_OPEN_EVENT, { prompt: withNodeMention(ctx.id, prompt) })
      }
    })
  ]
})

/** 消息里还没提及这个节点：开头补一枚；已经提及了（在哪都算）原样返回 */
export function withNodeMention(nodeId: string, text: string): string {
  if (parseNodeMentions(text).includes(nodeId)) return text
  return `${formatNodeMention(nodeId)} ${text}`
}
