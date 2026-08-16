import { computed, ref } from "vue"
import type { useFlowStore } from "@/stores/flow"
import type { FlowNodeData } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * **节点**的选中态，以及「针对选中节点」的编辑动作。
 *
 * 所有写操作都转成 FlowOp 交给 store.apply —— 这里不直接碰 store.nodes。
 *
 * 只管节点：边的选中态在 Vue Flow 内部（属性面板只认节点，没必要再维护一份）。
 * 需要「选中的元素」这个统一概念时去 `useFlowCanvas` —— 它把两边合成一份元素
 * key 列表上报给反馈层，删除也在那里统一处理。
 */
export function useFlowSelection(store: FlowStore) {
  const selectedNodeId = ref<string | null>(null)

  const selectedNode = computed(
    () => store.nodes.find((node) => node.id === selectedNodeId.value) ?? null
  )

  function select(id: string | null) {
    selectedNodeId.value = id
  }

  function clearSelection() {
    selectedNodeId.value = null
  }

  /**
   * 改选中节点的业务数据。
   *
   * `before` 从当前值里按 patch 的键逐个取，这样撤销时只回滚改动的那几个字段；
   * 值没变就不产生操作（输入框 change 事件会在没编辑时也触发）。
   */
  function updateNodeData(patch: Partial<FlowNodeData>, label: string) {
    const node = selectedNode.value
    if (!node) return

    const keys = Object.keys(patch) as (keyof FlowNodeData)[]
    const before: Partial<FlowNodeData> = {}
    for (const key of keys) {
      before[key] = node.data[key] as never
    }
    if (JSON.stringify(before) === JSON.stringify(patch)) return

    store.apply(
      [{ type: "node.update", targetId: node.id, before: { data: before }, after: { data: patch } }],
      label
    )
  }

  return {
    selectedNodeId,
    selectedNode,
    select,
    clearSelection,
    updateNodeData
  }
}

export type FlowSelection = ReturnType<typeof useFlowSelection>
