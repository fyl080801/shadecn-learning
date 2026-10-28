import type { Node, NodeProps } from "@vue-flow/core"
import type {
  FlowNode,
  FlowNodeInput,
  FlowNodeMetadata,
  FlowNodeRuntime
} from "@shadecn/shared/flow-graph"

/**
 * 投影节点（`FlowNode`，五组 + inputs）↔ Vue Flow 节点之间的那层映射。
 *
 * 这是条叶子：只有类型 import，谁引它都不成环（和 `node-constants.ts` 同一个理由）。
 *
 * **layout 摊到顶层**（Vue Flow 认的就是平铺的 position / width / parentNode…），
 * **其余四组装进 Vue Flow 的 `data`**。节点组件真正读数据走的是 `useFlowNode(id)`（直接读 store），
 * 这份 `data` 只是让 Vue Flow 生态里别的东西（小地图、`useNode()`）也看得到同样的内容。
 */
export interface FlowNodeViewData {
  metadata: FlowNodeMetadata
  data: Record<string, unknown>
  runtime: FlowNodeRuntime
  inputs: FlowNodeInput[]
}

export type FlowNodeViewProps = NodeProps<FlowNodeViewData>

/**
 * 每个投影节点只映射一次：同一个 `FlowNode` 对象永远换回同一个 Vue Flow 节点对象。
 *
 * 对象身份是要守的不变式 —— Vue Flow 靠引用判断节点要不要重新同步，投影层
 * （`createNodeProjector`）对没变的节点保留了引用，这里不能在最后一步把它弄丢。
 * WeakMap：投影节点一被换掉，旧的映射跟着被回收。
 */
const viewCache = new WeakMap<FlowNode, Node<FlowNodeViewData>>()

export function toVueFlowNode(node: FlowNode): Node<FlowNodeViewData> {
  const cached = viewCache.get(node)
  if (cached) return cached

  const { position, width, height, zIndex, parentNode, extent, sourcePosition, targetPosition } =
    node.layout
  const view = {
    id: node.id,
    type: node.type,
    position,
    // 布局键**一律显式写出来**，没有就是 undefined：Vue Flow 合并节点用的是
    // Object.assign(它内部那份, 传进来的这份)，键不出现的话上一次的值会留着 ——
    // 解组之后 extent 还是 'parent'、尺寸还是旧的
    width,
    height,
    zIndex,
    parentNode,
    extent,
    sourcePosition,
    targetPosition,
    data: {
      metadata: node.metadata,
      data: node.data,
      runtime: node.runtime,
      inputs: node.inputs
    }
  } as Node<FlowNodeViewData>
  viewCache.set(node, view)
  return view
}
