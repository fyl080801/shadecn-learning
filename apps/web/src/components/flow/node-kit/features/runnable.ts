import { defineNodeFeature, defineNodeHandler } from "../protocol"

/**
 * 可运行（REQ-NODEKIT §6）—— 第一版只到「发出运行请求」为止：谁执行、怎么回写 `runtime.status` / `outputs`
 * 是另一个需求（运行器）。这里的价值是证明「输入框 → 事件 → 运行请求」三方互不 import 也能串起来：
 * 底部输入框只发 `composer:submit`，这个能力接住它转成 `node:run`，运行器将来只订阅 `node:run`。
 *
 * **没有「运行」按钮**：运行器还没接上，一个点了没反应的按钮比没有按钮更糟。运行器落地时再加动作。
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
