import { computed, ref } from "vue"
import type { useFlowStore } from "@/stores/flow"
import type { FlowNodeData, FlowOp } from "@/types/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * 选中态，以及「针对选中节点」的编辑动作。
 *
 * 所有写操作都转成 FlowOp 交给 store.apply —— 这里不直接碰 store.nodes。
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

  /**
   * 删除选中的节点。
   *
   * 连着的边必须放进**同一个事务**：这样撤销时边和节点一起回来，
   * 而且 invertOps 会把顺序倒过来 —— 先加回节点，再加回边。
   */
  function deleteSelection() {
    const node = selectedNode.value
    if (!node) return

    const attached = store.edges.filter(
      (edge) => edge.source === node.id || edge.target === node.id
    )

    const ops: FlowOp[] = [
      ...attached.map<FlowOp>((edge) => ({
        type: "edge.remove",
        targetId: edge.id,
        before: { ...edge },
        after: null
      })),
      { type: "node.remove", targetId: node.id, before: { ...node }, after: null }
    ]

    store.apply(ops, "删除节点")
    clearSelection()
  }

  return {
    selectedNodeId,
    selectedNode,
    select,
    clearSelection,
    updateNodeData,
    deleteSelection
  }
}

export type FlowSelection = ReturnType<typeof useFlowSelection>
