import { useAsyncAction } from "@/composables/useAsyncAction"

import type { NodeActionDef, NodePartContext } from "./protocol"
import type { NodeKit } from "./registry"
import { matchesShortcut, parseShortcut, type Shortcut } from "./shortcut"

/**
 * 动作的执行（REQ-NODEKIT §4.5）—— 按钮和快捷键走**同一个**执行器，整张画布一份：
 *
 * - 「一次点击一次请求」走 `useAsyncAction`，按「节点 × 动作」各锁各的 ——
 *   按钮还在转圈时再按一次快捷键，第二下同样被丢掉；
 * - 每次执行前后各发一个事件（`action:invoke` / `action:done`），这是给工具扩展行为的入口：
 *   想在「删除」之后做点什么就订阅事件，不去改「删除」这个动作；
 * - `run` 抛错由 `useAsyncAction` 统一 toast，动作自己不用 try/catch。
 */
export function createNodeActionRunner(kit: Pick<NodeKit, "allActionsFor">) {
  const { run, isPending: pendingKey } = useAsyncAction(
    async (ctx: NodePartContext, action: NodeActionDef) => {
      ctx.emit("action:invoke", { action: action.id })
      try {
        await action.run(ctx)
      } catch (error) {
        ctx.emit("action:done", { action: action.id, error })
        throw error
      }
      ctx.emit("action:done", { action: action.id })
    },
    { key: (ctx, action) => `${ctx.id}\u0000${action.id}`, errorMessage: "操作失败" }
  )

  function isPending(nodeId: string, actionId: string) {
    return pendingKey(`${nodeId}\u0000${actionId}`)
  }

  function visible(ctx: NodePartContext, action: NodeActionDef) {
    return !action.when || action.when(ctx)
  }

  function enabled(ctx: NodePartContext, action: NodeActionDef) {
    return !action.enabled || action.enabled(ctx)
  }

  /** 解析过的快捷键按写法缓存：同一个字符串只解析一次 */
  const parsed = new Map<string, Shortcut>()
  function shortcutOf(text: string): Shortcut {
    let shortcut = parsed.get(text)
    if (!shortcut) {
      shortcut = parseShortcut(text)
      parsed.set(text, shortcut)
    }
    return shortcut
  }

  /**
   * 按键 → 这个节点上的动作。返回「这一下是不是被节点动作接走了」，接走了调用方就 `preventDefault`。
   *
   * 只看**此刻出现**的动作（`when`），和按钮看得见的那一排一致 —— 没出现的按钮，快捷键也不该触发它。
   * 命中了但置灰（`enabled` 为假）的照样算接走、只是不执行：`Mod+D` 落空了也不该弹出浏览器的「加书签」。
   */
  function dispatchShortcut(ctx: NodePartContext, event: KeyboardEvent): boolean {
    for (const action of kit.allActionsFor(ctx.type)) {
      if (!action.shortcut || !matchesShortcut(shortcutOf(action.shortcut), event)) continue
      if (!visible(ctx, action)) continue
      if (enabled(ctx, action)) void run(ctx, action)
      return true
    }
    return false
  }

  return { run, isPending, enabled, dispatchShortcut }
}

export type NodeActionRunner = ReturnType<typeof createNodeActionRunner>
