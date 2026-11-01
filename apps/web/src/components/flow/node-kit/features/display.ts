import { flowAppTasksFor } from "@/composables/flow/useFlowAppTasks"

import { defineNodeFeature, defineNodePart, ORDER_FRAMEWORK, type NodePartContext } from "../protocol"
import ConnectableHandles from "./ConnectableHandles.vue"
import StatusError from "./StatusError.vue"
import StatusProcessing from "./StatusProcessing.vue"

/** 连接点：左右最多各一个、不带 id，按端口声明决定画不画哪一侧（见 `FlowNodeHandles`）。分组不启用 */
export const connectableFeature = defineNodeFeature({
  id: "connectable",
  parts: [defineNodePart({ id: "connectable.handles", slot: "handles", component: ConnectableHandles })]
})

/**
 * 节点在不在生成：`runtime.status === 'processing'`（执行副本已经在跑，它写的），或者画布的任务列表里有它**排队中**的任务 ——
 * 排队中还没有执行副本接手，节点的 `runtime` 上没有痕迹（docs/29 §3.10）
 */
function isProcessing(ctx: NodePartContext): boolean {
  if (ctx.node.runtime.value.status === "processing") return true
  return flowAppTasksFor(ctx.editor.flowId.value)?.taskOn(ctx.id) !== undefined
}

/**
 * 运行态的展示，都盖在节点主体上（overlay 区，不撑开节点）：
 * processing / 排队中一圈高亮 + 「排队中」/「生成中」（生成任务的进度、取消，docs/29 §3.10）；error 红框 + 「生成失败」（完整的 `runtime.error` 在悬停提示里）。
 */
export const statusFeature = defineNodeFeature({
  id: "status",
  parts: [
    defineNodePart({
      id: "status.processing",
      slot: "overlay",
      order: ORDER_FRAMEWORK,
      component: StatusProcessing,
      when: isProcessing
    }),
    defineNodePart({
      id: "status.error",
      slot: "overlay",
      order: ORDER_FRAMEWORK,
      component: StatusError,
      when: (ctx) => ctx.node.runtime.value.status === "error" && !isProcessing(ctx)
    })
  ],
  rootClass: (ctx) => {
    // 描边环 / 边框色按屏幕像素画，样式在 vue-flow.css 的 `.flow-node-processing` / `.flow-node-error`
    if (isProcessing(ctx)) return "flow-node-processing"
    if (ctx.node.runtime.value.status === "error") return "flow-node-error"
    return null
  }
})
