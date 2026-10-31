import { defineNodeFeature, defineNodePart, ORDER_FRAMEWORK } from "../protocol"
import ConnectableHandles from "./ConnectableHandles.vue"
import StatusBadge from "./StatusBadge.vue"
import StatusError from "./StatusError.vue"

/** 连接点：左右最多各一个、不带 id，按端口声明决定画不画哪一侧（见 `FlowNodeHandles`）。分组不启用 */
export const connectableFeature = defineNodeFeature({
  id: "connectable",
  parts: [defineNodePart({ id: "connectable.handles", slot: "handles", component: ConnectableHandles })]
})

/**
 * 运行态的展示：processing 一圈高亮 + 「运行中」角标；error 红框 + `runtime.error`（没有就给兜底）。
 * 错误行紧跟在 body 后面，排在 footer 区最前。
 */
export const statusFeature = defineNodeFeature({
  id: "status",
  parts: [
    defineNodePart({
      id: "status.badge",
      slot: "badge",
      order: ORDER_FRAMEWORK,
      component: StatusBadge,
      when: (ctx) => ctx.node.runtime.value.status === "processing"
    }),
    defineNodePart({
      id: "status.error",
      slot: "footer",
      order: ORDER_FRAMEWORK,
      component: StatusError,
      when: (ctx) => ctx.node.runtime.value.status === "error"
    })
  ],
  rootClass: (ctx) => {
    const status = ctx.node.runtime.value.status
    // 描边环 / 边框色按屏幕像素画，样式在 vue-flow.css 的 `.flow-node-processing` / `.flow-node-error`
    if (status === "processing") return "flow-node-processing"
    if (status === "error") return "flow-node-error"
    return null
  }
})
