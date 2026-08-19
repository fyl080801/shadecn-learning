import { ref } from "vue"

/**
 * **节点**的选中态。
 *
 * 只是「现在轮到哪个节点」这一个 id：选中不再打开任何面板，它的用处是
 * 上报给反馈层（别人看得到我在动哪个节点）、决定节点头上的工具栏露不露，
 * 以及给删除动作一个默认目标。改节点数据的入口在节点自己身上（双击改名）。
 *
 * 只管节点：边的选中态在 Vue Flow 内部，没必要再维护一份。
 * 需要「选中的元素」这个统一概念时去 `useFlowCanvas` —— 它把两边合成一份元素
 * key 列表上报给反馈层，删除也在那里统一处理。
 */
export function useFlowSelection() {
  const selectedNodeId = ref<string | null>(null)

  function select(id: string | null) {
    selectedNodeId.value = id
  }

  function clearSelection() {
    selectedNodeId.value = null
  }

  return {
    selectedNodeId,
    select,
    clearSelection
  }
}

export type FlowSelection = ReturnType<typeof useFlowSelection>
