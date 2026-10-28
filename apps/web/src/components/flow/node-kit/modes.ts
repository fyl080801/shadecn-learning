import { computed, shallowRef } from "vue"

import type {
  NodeModeDef,
  NodeModeExitReason,
  NodeModeView,
  NodePartContext,
  NodeSlot
} from "./protocol"
import type { NodeKit } from "./registry"

/**
 * 编辑模式的状态机（REQ-NODEKIT §4.6）。
 *
 * **整张画布同一时刻只有一个节点可编辑** —— 所以状态是编辑器级的**一个值**
 * `{ nodeId, mode } | null`，不是每个节点各存一份；`NodeModeView` 只是它在某个节点上的视图。
 * 由此：
 * - 进入新模式（同一节点或别的节点）→ 旧的以 `'preempted'` 退出；
 * - 选中了别的节点（`syncSelection`）→ 正在编辑的那个以 `'preempted'` 退出。
 *
 * `'preempted'` 时草稿怎么办由模式的 `exit` 钩子决定，约定是**提交**（与现在点别处 → blur → commit 一致），
 * 只有 `'cancel'`（Esc）丢草稿。
 *
 * 模式状态是本地 UI 状态：不进文档、不进撤销、不跨客户端。
 * `exit` 钩子里不要再 `enter` 别的模式 —— 状态在调钩子之前已经清掉了，那样进去的模式会被随后的赋值覆盖。
 */

interface ActiveMode {
  nodeId: string
  def: NodeModeDef
  ctx: NodePartContext
}

export function createNodeModeController(kit: Pick<NodeKit, "findMode">) {
  const active = shallowRef<ActiveMode | null>(null)

  /** 当前谁在编辑、在哪个模式里 */
  const current = computed(() =>
    active.value ? { nodeId: active.value.nodeId, mode: active.value.def.id } : null
  )

  function safely(label: string, task: () => void) {
    try {
      task()
    } catch (error) {
      console.error(`[node-kit] 模式钩子 ${label} 出错`, error)
    }
  }

  function finish(prev: ActiveMode, reason: NodeModeExitReason) {
    if (active.value === prev) active.value = null
    safely(`${prev.def.id}.exit`, () => prev.def.exit?.(prev.ctx, reason))
    prev.ctx.emit("mode:exit", { mode: prev.def.id, reason })
  }

  /** 让节点进入某模式。类型没启用这个模式就拒绝（返回 false） */
  function enter(ctx: NodePartContext, mode: string): boolean {
    const def = kit.findMode(ctx.type, mode)
    if (!def) {
      console.warn(`[node-kit] 节点类型 ${ctx.type} 没有启用模式 ${mode}`)
      return false
    }
    const prev = active.value
    if (prev && prev.nodeId === ctx.id && prev.def.id === mode) return true
    if (prev) finish(prev, "preempted")
    active.value = { nodeId: ctx.id, def, ctx }
    safely(`${mode}.enter`, () => def.enter?.(ctx))
    ctx.emit("mode:enter", { mode })
    return true
  }

  /** 结束当前模式；给了 `nodeId` 就只在它正是那个节点时才结束 */
  function exit(reason: NodeModeExitReason = "commit", nodeId?: string) {
    const prev = active.value
    if (!prev) return
    if (nodeId !== undefined && prev.nodeId !== nodeId) return
    finish(prev, reason)
  }

  /** 选中态变了：编辑中的节点不再是被选中的那个，它的编辑就取消（以 preempted 退出） */
  function syncSelection(selectedNodeId: string | null) {
    const prev = active.value
    if (prev && prev.nodeId !== selectedNodeId) finish(prev, "preempted")
  }

  function modeOf(nodeId: string): string | null {
    return active.value?.nodeId === nodeId ? active.value.def.id : null
  }

  /** 当前模式对这个节点的某个区域的要求：强制露出 / 强制收起 / 没要求 */
  function slotOverride(nodeId: string, slot: NodeSlot): "reveal" | "conceal" | null {
    const mode = active.value
    if (!mode || mode.nodeId !== nodeId) return null
    if (mode.def.conceal?.includes(slot)) return "conceal"
    if (mode.def.reveal?.includes(slot)) return "reveal"
    return null
  }

  /**
   * 给某个节点的上下文用的视图。`getCtx` 是惰性的：上下文本身就含着这个视图，构造时还没有它。
   */
  function viewFor(nodeId: () => string, getCtx: () => NodePartContext): NodeModeView {
    return {
      current: computed(() => modeOf(nodeId())),
      enter: (mode) => enter(getCtx(), mode),
      exit: (reason) => exit(reason, nodeId())
    }
  }

  return { current, enter, exit, syncSelection, modeOf, slotOverride, viewFor }
}

export type NodeModeController = ReturnType<typeof createNodeModeController>
