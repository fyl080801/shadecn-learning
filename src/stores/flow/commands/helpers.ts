import type { FlowEdge, FlowNode, FlowOp } from "@/types/flow"
import type { FlowCommandContext } from "../registry"

/** 命令之间共用的小工具，避免每个命令文件重复一遍。 */

/**
 * 深拷贝。图内容本来就是要序列化成 JSON 存的，走 JSON 一趟正好；
 * 而 structuredClone 克隆不了 Vue 的 reactive Proxy（DataCloneError）。
 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 按 id 打补丁改一个节点。
 *
 * 整个数组换新引用而不是原地改：Vue Flow 靠引用变化判断要不要重渲染。
 * `data` 是合并而不是替换 —— 补丁里只给了 label 时，config / ports 不能被抹掉。
 */
export function patchNode(ctx: FlowCommandContext, op: FlowOp) {
  const index = ctx.nodes.value.findIndex((node) => node.id === op.targetId)
  if (index === -1) return

  const patch = (op.after ?? {}) as Partial<FlowNode>
  const current = ctx.nodes.value[index]!
  const next: FlowNode = {
    ...current,
    ...patch,
    data: patch.data ? { ...current.data, ...patch.data } : current.data
  }

  ctx.nodes.value = ctx.nodes.value.map((node, i) => (i === index ? next : node))
}

export function patchEdge(ctx: FlowCommandContext, op: FlowOp) {
  const index = ctx.edges.value.findIndex((edge) => edge.id === op.targetId)
  if (index === -1) return

  const patch = (op.after ?? {}) as Partial<FlowEdge>
  const current = ctx.edges.value[index]!

  ctx.edges.value = ctx.edges.value.map((edge, i) =>
    i === index ? { ...current, ...patch } : edge
  )
}
