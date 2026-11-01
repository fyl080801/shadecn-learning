import { defineNodeFeature, defineNodeHandler } from "../protocol"

/**
 * 可运行（REQ-NODEKIT §6）—— 只到「发出运行请求」为止：谁执行、怎么回写 `runtime.status` 是运行器的事。
 * 「输入框 → 事件 → 运行请求 → 运行器」互不 import 也能串起来：底部输入框只发 `composer:submit`，
 * 这个能力接住它转成 `node:run`，运行器只订阅 `node:run` —— 眼下的运行器是 `app-run`（用应用生成，docs/29 §3.8）。
 *
 * 没有单独的「运行」按钮：发送键 / 输入框的发送按钮就是运行。
 */

declare module "@/components/flow/node-kit/protocol" {
  interface FlowNodeEventMap {
    /** 请求运行这个节点。`prompt` 是触发它的那段提示词（从底部输入框来的才有） */
    "node:run": { prompt?: string }
  }
}

export const runnableFeature = defineNodeFeature({
  id: "runnable",
  handlers: [
    defineNodeHandler({
      event: "composer:submit",
      handle: ({ text }, ctx) => {
        // 空提示词不是一次运行请求，只是把框清空了
        if (!text.trim()) return
        ctx.emit("node:run", { prompt: text })
      }
    })
  ]
})
