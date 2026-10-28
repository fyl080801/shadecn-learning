import { defaultNodeData, FALLBACK_NODE_TYPE, type FlowNode, type FlowNodeData } from './flow-graph.ts'

/**
 * 节点类型注册表的**数据那一半** —— `type`、新建时的默认业务 `data`、默认顶层字段。
 *
 * 渲染那一半（组件、图标、菜单名）留在前端的 `apps/web/src/components/flow/node-types.ts`，
 * 它从这里取默认值再补上自己的。拆开是因为服务端也要「新建一个节点」：
 * agent 的画布工具（`@shadecn/agent`）建出来的节点必须和人在界面上点出来的一模一样，
 * 默认值只能有一份，否则同一种节点会因为谁建的而长得不一样（REQ-AGENT §3.2）。
 *
 * **加一种节点**：这里加一条（有默认值的话），前端注册表加一条（组件 + 图标）。
 *
 * 只用 ES2020，不碰 DOM / Node API（见本包 tsconfig 的护栏）。
 */

/** 分组框的 `type`。打组（`useFlowCanvas.groupSelection`）建的就是它 */
export const GROUP_NODE_TYPE = 'group'

/** 分组框的默认底色。半透明，因为它是背景板不是卡片 */
export const GROUP_DEFAULT_BACKGROUND = 'rgba(120, 120, 140, 0.10)'

/** 分组框的默认尺寸：够放下两三个节点，剩下的自己拉 */
export const GROUP_DEFAULT_SIZE = { width: 520, height: 360 }

/**
 * 分组框的层级。
 *
 * 必须是负数：分组是**背景板**，画在所有节点下面。Vue Flow 的节点默认 zIndex 为 0，
 * 给 0 或不给的话，后建的分组会盖住先建的节点，把它们整片挡掉。
 */
export const GROUP_Z_INDEX = -1

/**
 * 连线的 `type`。前端 `useFlowCanvas` 的 `FLOW_EDGE_TYPE` 是同一个值（Vue Flow 的默认边）；
 * agent 建的边照这个写，两边建出来的边才没有差别。
 */
export const DEFAULT_EDGE_TYPE = 'default'

export interface FlowNodeTypeDefaults {
  /** 顶层 `type`，也是注册表的键 */
  type: string
  /**
   * 新建时铺在 `data` 上的**业务字段**。
   * 框架字段（label / status / createdAt）由 `defaultNodeData()` 保证，这里不用管。
   */
  defaultData?: () => Record<string, unknown>
  /** 新建时的顶层字段（尺寸、层级…） */
  defaultNode?: () => Partial<Omit<FlowNode, 'id' | 'type' | 'position' | 'data'>>
}

export const FLOW_NODE_TYPE_DEFAULTS: Record<string, FlowNodeTypeDefaults> = {
  text: {
    type: 'text',
    // 正文单独占一个 key（平铺在 data 上）：两个人一个改标题一个改正文才不会互相盖掉
    defaultData: () => ({ text: '' }),
  },
  process: {
    type: 'process',
  },
  [GROUP_NODE_TYPE]: {
    type: GROUP_NODE_TYPE,
    defaultData: () => ({ background: GROUP_DEFAULT_BACKGROUND }),
    defaultNode: () => ({ ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX }),
  },
}

/** 认不认识这个 type；认不出来的按兜底类型（和 `fromYNode` 读缺失 type 时同一个） */
export function nodeTypeDefaultsOf(type: string): FlowNodeTypeDefaults {
  return FLOW_NODE_TYPE_DEFAULTS[type] ?? FLOW_NODE_TYPE_DEFAULTS[FALLBACK_NODE_TYPE]!
}

/** 拼一个新节点的 data —— 框架字段 + 该类型自己的业务字段 */
export function buildNodeData(type: string, label: string): FlowNodeData {
  return defaultNodeData(label, nodeTypeDefaultsOf(type).defaultData?.())
}

/** 拼一个新节点的顶层字段（尺寸、层级…） */
export function buildNodeDefaults(type: string): Partial<FlowNode> {
  return nodeTypeDefaultsOf(type).defaultNode?.() ?? {}
}
