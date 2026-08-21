import { ref } from "vue"

/**
 * 「现在轮到哪个节点」—— **Vue Flow 选中态的投影，不是第二份选中态**。
 *
 * 唯一的写入点是 `useFlowCanvas` 里那个 watch：Vue Flow 恰好选中一个节点时是它的 id，
 * 没选或框选了一片时是 null。别的地方只读它，要改选中就调 `canvas.selectOnly()` ——
 * 自己维护一份的下场见那个 watch 的注释（先点 A 再拖 B，两个节点同时挂着工具栏）。
 *
 * 它的用处是决定节点头上的工具栏露不露。选中本身不打开任何面板，改节点数据的入口
 * 在节点自己身上（双击改名）。
 *
 * 只管节点：边的选中态在 Vue Flow 内部，没必要再投影一份。需要「选中的元素」这个
 * 统一概念（上报反馈层、删除）时去 `useFlowCanvas`，那里直接读 Vue Flow 的两份列表。
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
