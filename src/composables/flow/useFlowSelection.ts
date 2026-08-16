import { computed, ref } from "vue"
import type { useFlowStore } from "@/stores/flow"
import type { FlowNodeData } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * **节点**的选中态，以及「针对选中节点」的编辑动作。
 *
 * 所有写操作都交给 store（最终落到 `mutate` 的 Y 事务）—— 这里不直接碰 Y.Map。
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
   * 值没变就不写（输入框 change 事件在没编辑时也会触发），省得凭空产生一条
   * 撤销记录、也省得把一次空更新广播给所有人。
   */
  function updateNodeData(patch: Partial<FlowNodeData>, label: string) {
    const node = selectedNode.value
    if (!node) return

    const changed: Partial<FlowNodeData> = {}
    for (const [key, value] of Object.entries(patch) as [keyof FlowNodeData, unknown][]) {
      if (JSON.stringify(node.data[key]) === JSON.stringify(value)) continue
      changed[key] = value as never
    }
    if (Object.keys(changed).length === 0) return

    store.updateNodeData(node.id, changed, label)
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
