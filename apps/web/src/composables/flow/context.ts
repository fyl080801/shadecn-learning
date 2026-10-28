import { computed, provide, toRef, watch } from "vue"
import { useFlowStore } from "@/stores/flow"
import { FLOW_EDITOR_KEY, type FlowEditorContext } from "./editor-context"
import { useFlowCanvas } from "./useFlowCanvas"
import { useFlowDocument } from "./useFlowDocument"
import { useFlowPresence } from "./useFlowPresence"
import { useFlowSelection } from "./useFlowSelection"
import { useFlowSync } from "./sync"

/**
 * 画布编辑器的共享上下文。
 *
 * 编辑器根组件 `provideFlowEditor()` 一次，工具栏 / 胶囊 / 属性面板这些
 * 子组件 `useFlowEditor()` 就能拿到同一份状态和动作 —— 不用一层层传 props，
 * 加一个面板也不需要改中间任何一层。
 *
 * 这个文件只有**写入侧**（`provideFlowEditor`）：它要 import 每一个 composable。
 * 读取侧（`FlowEditorContext` / `useFlowEditor`）在 `./editor-context.ts`，
 * 那边是条不引任何东西的叶子 —— 原因写在它顶上，一句话是「不这么分就成环」。
 */

/** 只能在编辑器根组件的 setup 里调用一次 */
export function provideFlowEditor(props: { flowId: string }): FlowEditorContext {
  const store = useFlowStore()
  const flowId = toRef(props, "flowId")

  /*
   * 构造顺序 = 依赖方向，是条直线，不成环：
   *
   *   selection ──┐
   *   sync ────┬──┴─→ canvas   （canvas 是唯一同时认识三者的接合层）
   *            └─→ presence ──┘
   *
   * presence 不认识 selection 也不认识 Vue Flow，只提供「上报」和「读别人」；
   * 本地状态怎么接进去、别人的占用怎么落到画布上，都由 canvas 负责。
   */
  const selection = useFlowSelection()

  /**
   * 这张画布是什么（项目画布 / 个人画布）—— 服务端说了算，跟着元信息一起回来（REQ-SOLO）。
   *
   * 传输两种画布一样（都是 WebSocket），`mode` 决定的是「画布是什么」：在场层开不开、
   * 返回落点、终局文案。同步层也等它 —— 元信息到了才挂传输（原因见 `sync/index.ts`）。
   *
   * **必须比对 id**：换画布时 `store.meta` 会在新元信息到达之前继续留着上一张的，
   * 拿它去判断就会把上一张的种类套到新画布上（比如在个人画布上开出在场层）。
   * 对不上就是「还不知道」，等着。
   */
  const mode = computed(() =>
    store.meta && store.meta.id === flowId.value ? store.meta.mode : null
  )

  const sync = useFlowSync(flowId, mode)
  const presence = useFlowPresence(sync, mode)

  /**
   * 文档建好之后交给 store —— **画布内容从这一刻起就是它了**。
   * 换画布、重建传输都会给出新的 session，跟着换一次接管对象。
   */
  watch(
    () => sync.session.value,
    (session) => {
      if (session) store.attachDoc(session.doc)
      else store.detach()
    },
    { immediate: true }
  )

  const context: FlowEditorContext = {
    flowId,
    store,
    sync,
    document: useFlowDocument(flowId, store, sync),
    canvas: useFlowCanvas(store, presence, selection),
    selection,
    presence
  }

  provide(FLOW_EDITOR_KEY, context)
  return context
}
