import { inject, provide, toRef, type InjectionKey } from "vue"
import { useFlowStore } from "@/stores/flow"
import { useFlowCanvas } from "./useFlowCanvas"
import { useFlowCollab } from "./useFlowCollab"
import { useFlowDocument } from "./useFlowDocument"
import { useFlowPresence } from "./useFlowPresence"
import { useFlowSelection } from "./useFlowSelection"
import { useFlowSync } from "./useFlowSync"

/**
 * 画布编辑器的共享上下文。
 *
 * 编辑器根组件 `provideFlowEditor()` 一次，工具栏 / 胶囊 / 属性面板这些
 * 子组件 `useFlowEditor()` 就能拿到同一份状态和动作 —— 不用一层层传 props，
 * 加一个面板也不需要改中间任何一层。
 */

export interface FlowEditorContext {
  /** 当前画布 id（响应式，路由切换时会变） */
  flowId: Readonly<ReturnType<typeof toRef<string>>>
  /** 底层状态与历史；写操作最终都落到 store.apply */
  store: ReturnType<typeof useFlowStore>
  /** 文档级：加载 / 改名 / 复制 / 删除 / 保存状态 */
  document: ReturnType<typeof useFlowDocument>
  /** 画布交互：Vue Flow 绑定、视口、新增节点 */
  canvas: ReturnType<typeof useFlowCanvas>
  /** 选中态与针对选中节点的编辑 */
  selection: ReturnType<typeof useFlowSelection>
  /** 多人在场：谁在线、光标在哪、哪些节点被别人占住 */
  presence: ReturnType<typeof useFlowPresence>
}

const FLOW_EDITOR_KEY: InjectionKey<FlowEditorContext> = Symbol("flow-editor")

/** 只能在编辑器根组件的 setup 里调用一次 */
export function provideFlowEditor(props: { flowId: string }): FlowEditorContext {
  const store = useFlowStore()
  const flowId = toRef(props, "flowId")

  /*
   * 构造顺序 = 依赖方向，是条直线，不成环：
   *
   *   selection ──┐
   *   collab ──┬──┴─→ canvas   （canvas 是唯一同时认识三者的接合层）
   *            └─→ presence ──┘
   *            └─→ sync
   *
   * presence 不认识 selection 也不认识 Vue Flow，只提供「上报」和「读别人」；
   * 本地状态怎么接进去、别人的占用怎么落到画布上，都由 canvas 负责。
   */
  const selection = useFlowSelection(store)
  const collab = useFlowCollab(flowId)
  const presence = useFlowPresence(collab)
  // 编辑操作的实时广播；没有返回值，挂上就一直在跑
  useFlowSync(collab, store)

  const context: FlowEditorContext = {
    flowId,
    store,
    document: useFlowDocument(flowId, store),
    canvas: useFlowCanvas(store, presence, selection),
    selection,
    presence
  }

  provide(FLOW_EDITOR_KEY, context)
  return context
}

/** 子组件取上下文；不在编辑器里用会直接报错，而不是拿到 undefined 到处炸 */
export function useFlowEditor(): FlowEditorContext {
  const context = inject(FLOW_EDITOR_KEY, null)
  if (!context) {
    throw new Error("useFlowEditor() 必须用在 provideFlowEditor() 的子树里")
  }
  return context
}
