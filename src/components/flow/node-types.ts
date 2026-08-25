import { markRaw, type Component } from "vue"
import { Box, Frame, Type } from "@lucide/vue"

import GroupNode from "@/components/flow/GroupNode.vue"
import ProcessNode from "@/components/flow/ProcessNode.vue"
import TextNode from "@/components/flow/TextNode.vue"
import { defaultNodeData, type FlowNode, type FlowNodeData } from "@/types/flow"
import {
  FALLBACK_NODE_TYPE,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_Z_INDEX
} from "./node-constants"

/**
 * 常量在 `./node-constants.ts` 里定义、从这里 re-export —— 对外仍然「注册表一个文件」。
 * 分开放是为了断环：这个文件 import 各种节点组件，而节点组件要读那些常量，
 * 写在一起 rollup 打包时会挑错求值顺序（详见 node-constants.ts 顶部）。
 */
export {
  FALLBACK_NODE_TYPE,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_NODE_TYPE,
  GROUP_Z_INDEX,
  NEW_NODE_TYPE
} from "./node-constants"

/**
 * 节点类型注册表 —— **加一种节点只动这一个文件**。
 *
 * 节点的业务种类就是它顶层的 `type`（v2 起 `data.kind` 已经并进来了，见
 * `src/types/flow.ts`），这张表的键即是它：由谁渲染、菜单里叫什么、新建时长什么样，
 * 全在一处说清楚。画布（`FlowCanvas.vue`）、工具栏（`FlowToolbar.vue`）和
 * 新建逻辑（`useFlowCanvas.addNode`）都从这里取，没有第二处硬编码。
 *
 * 工具栏**不再按这张表铺一排按钮**：加号只建 `NEW_NODE_TYPE` 那一种，
 * `label` / `icon` 留给节点自己和将来的类型菜单用。
 *
 * 示例数据（`sample/画布数据参考/`）里有 8 种节点，形状彼此完全不同 ——
 * 这张表就是让它们能共存的地方：`process` 是内容自适应的普通节点，
 * `group` 是带固定尺寸、压在所有节点之下的分组框，两者除了 `type` 之外没有共同点。
 */
export interface FlowNodeTypeDef {
  /** 顶层 `type`，也是这张表的键 */
  type: string
  /** 菜单里显示的名字 */
  label: string
  icon: Component
  component: Component
  /**
   * 新建时铺在 `data` 上的**业务字段**。
   * 框架字段（label / status / createdAt）由 `defaultNodeData()` 保证，这里不用管。
   */
  defaultData?: () => Record<string, unknown>
  /** 新建时的顶层字段（尺寸、层级…） */
  defaultNode?: () => Partial<Omit<FlowNode, "id" | "type" | "position" | "data">>
}

export const FLOW_NODE_TYPES: Record<string, FlowNodeTypeDef> = {
  text: {
    type: "text",
    label: "文本",
    icon: Type,
    component: TextNode,
    // 正文单独占一个 key（平铺在 data 上）：两个人一个改标题一个改正文才不会互相盖掉
    defaultData: () => ({ text: "" })
  },
  process: {
    type: "process",
    label: "流程节点",
    icon: Box,
    component: ProcessNode
  },
  group: {
    type: "group",
    label: "分组",
    icon: Frame,
    component: GroupNode,
    defaultData: () => ({ background: GROUP_DEFAULT_BACKGROUND }),
    defaultNode: () => ({ ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX })
  }
}

/**
 * 喂给 `<VueFlow :node-types>` 的组件表。
 *
 * 在模块顶层建好并 `markRaw`：写成模板里的字面量的话每次渲染都是新对象，
 * Vue Flow 会把它存进自己的响应式 state，于是组件定义被 `reactive()` 包一层，
 * Vue 报 "received a Component that was made a reactive object"，
 * 节点类型也会白白重新解析一遍。
 */
export const flowNodeComponents = markRaw(
  Object.fromEntries(Object.values(FLOW_NODE_TYPES).map((def) => [def.type, def.component]))
)

/** 认不认识这个 type；认不出来的按默认类型渲染 */
export function flowNodeTypeOf(type: string): FlowNodeTypeDef {
  return FLOW_NODE_TYPES[type] ?? FLOW_NODE_TYPES[FALLBACK_NODE_TYPE]!
}

/** 按注册表拼一个新节点的 data —— 框架字段 + 该类型自己的业务字段 */
export function buildNodeData(type: string, label: string): FlowNodeData {
  return defaultNodeData(label, flowNodeTypeOf(type).defaultData?.())
}

/** 按注册表拼一个新节点的顶层字段（尺寸、层级…） */
export function buildNodeDefaults(type: string): Partial<FlowNode> {
  return flowNodeTypeOf(type).defaultNode?.() ?? {}
}
