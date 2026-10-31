import { inject, provide, watch, type InjectionKey, type Ref } from "vue"

import { createNodeActionRunner, type NodeActionRunner } from "./actions"
import { createNodeModeController, type NodeModeController } from "./modes"
import { FALLBACK_NODE_TYPE } from "../node-constants"
import type { NodePartContext, NodeTypeView } from "./protocol"
import { createNodeKit, type NodeKit } from "./registry"

/**
 * 节点扩展协议的两层注入（REQ-NODEKIT §4.4 / §4.9）：
 *
 * - **编辑器级**（`provideNodeKit`）：一份注册表 + 一个模式状态机 + 一个动作执行器。模式状态机必须整张画布
 *   只有一个 ——「同时只有一个节点可编辑」靠的就是所有节点共用它；执行器也只有一个，按钮和快捷键共用同一把锁；
 * - **节点级**（宿主 `NodeHost` provide、部件里 `useNodePart()` 取）：这个节点的上下文。
 *
 * 只引协议层的几个叶子模块，不引任何组件 —— 节点组件、部件组件都要引这里。
 */

export interface NodeKitRuntime {
  kit: NodeKit
  modes: NodeModeController
  actions: NodeActionRunner
  /**
   * 此刻挂在画布上的节点的上下文（宿主挂载时登记、卸载时注销）。
   * 快捷键要对「当前选中的节点」执行动作，得先拿到它的上下文 —— 上下文只有宿主建得出来。
   */
  hosts: Map<string, NodePartContext>
  /** 按键交给某个节点的动作；返回是否被接走（接走了调用方 `preventDefault`） */
  dispatchShortcut(nodeId: string, event: KeyboardEvent): boolean
}

export function createNodeKitRuntime(kit: NodeKit): NodeKitRuntime {
  const hosts = new Map<string, NodePartContext>()
  const actions = createNodeActionRunner(kit)
  return {
    kit,
    modes: createNodeModeController(kit),
    actions,
    hosts,
    dispatchShortcut(nodeId, event) {
      const ctx = hosts.get(nodeId)
      return ctx ? actions.dispatchShortcut(ctx, event) : false
    }
  }
}

export const NODE_KIT_KEY: InjectionKey<NodeKitRuntime> = Symbol("node-kit")
export const NODE_PART_KEY: InjectionKey<NodePartContext> = Symbol("node-part")

/**
 * 编辑器根组件 setup 里调一次。选中态一变，变成的若不是正在编辑的节点，它的编辑就取消
 * （进入编辑不选中节点，所以只在选中态变化时判，不要求编辑中的节点一直是被选中的那个）。
 */
export function provideNodeKit(kit: NodeKit, selectedNodeId: Readonly<Ref<string | null>>): NodeKitRuntime {
  const runtime = createNodeKitRuntime(kit)
  watch(selectedNodeId, (id) => runtime.modes.syncSelection(id))
  provide(NODE_KIT_KEY, runtime)
  return runtime
}

/** 没人 provide 时（单独挂载节点组件的测试）用的空注册表：什么都不挂，节点就是基础外观 */
let emptyRuntime: NodeKitRuntime | null = null

export function useNodeKitRuntime(): NodeKitRuntime {
  const provided = inject(NODE_KIT_KEY, null)
  if (provided) return provided
  if (!emptyRuntime) emptyRuntime = createNodeKitRuntime(createNodeKit())
  return emptyRuntime
}

/**
 * 按 type 取**另一个**节点的外观（图标、兜底名）—— 比如输入框里的提及 badge、上游预览格子。
 *
 * 节点子树里的组件（部件、body，以及它们引到的组件）**不要** import `node-types.ts` 的 `flowNodeTypeOf`：
 * 注册表要 import 这些组件，反过来引就成环（`node-types` → `composer-part` → `PromptComposer` → `node-types`），
 * 生产构建直接拒绝（`vite.config.ts` 的 onwarn）。注册表已经由编辑器注入（`provideNodeKit`），从这里查。
 * 没登记的 type 按兜底类型 —— 和 `flowNodeTypeOf` 同一条规则。
 */
export function useNodeTypeView(): (type: string) => NodeTypeView {
  const { kit } = useNodeKitRuntime()
  return (type) => {
    const view = kit.viewOf(type)
    return view.icon || view.fallbackLabel ? view : kit.viewOf(FALLBACK_NODE_TYPE)
  }
}

/** 部件组件、动作按钮取节点上下文；不在宿主里用会直接报错 */
export function useNodePart(): NodePartContext {
  const context = inject(NODE_PART_KEY, null)
  if (!context) throw new Error("useNodePart() 必须用在 NodeHost 的子树里")
  return context
}
