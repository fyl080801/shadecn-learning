import { inject, type InjectionKey, type toRef } from "vue"

import type { useFlowStore } from "@/stores/flow"
import type { useFlowCanvas } from "./useFlowCanvas"
import type { useFlowDocument } from "./useFlowDocument"
import type { useFlowPresence } from "./useFlowPresence"
import type { useFlowSelection } from "./useFlowSelection"
import type { useFlowSync } from "./sync"

/**
 * 上下文的**读取侧**：类型、注入 key、`useFlowEditor()`。
 *
 * 为什么和 `provideFlowEditor()` 分成两个文件 —— 这里上面那一排全是 `import type`，
 * 编译后一条 import 都不剩，所以这个模块是条叶子：谁引它都不会再被拖回去。
 * 写在 `context.ts` 里就不是了：那边要真的 import 每个 composable，其中
 * `useFlowCanvas` → `node-types` → 各种节点组件，而节点组件又要 `useFlowEditor()` ——
 * 成环。
 *
 * 环在 `pnpm dev` 下是看不见的（原生 ESM 有 live binding），rollup 打包却会把这些模块
 * 摊平进不同 chunk 并自己挑一个求值顺序 —— 挑错就是
 * `ReferenceError: Cannot access 'XX' before initialization`，画布编辑器整页白屏，
 * 而且**只在生产构建里出现**。所以规矩是：
 *
 *   `src/components/flow/` 下的组件要拿上下文，一律从这个文件引，
 *   不要从 `@/composables/flow` 那个 barrel 引。
 *
 * 现在只有节点组件（会被 `node-types` 引到）才真的成环，但「哪些组件在注册表的
 * 依赖图里」会随着新节点类型悄悄变化，所以整个目录统一走这里，不去逐个判断。
 * 忘了这条也不会漏到线上：`vite.config.ts` 里 rollup 的 `CYCLIC_CROSS_CHUNK_REEXPORT`
 * 警告被提成了错误，构建直接失败。
 */

export interface FlowEditorContext {
  /** 当前画布 id（响应式，路由切换时会变） */
  flowId: Readonly<ReturnType<typeof toRef<string>>>
  /** 底层状态与撤销；写操作最终都落到 store.mutate */
  store: ReturnType<typeof useFlowStore>
  /**
   * 内容的同步层：Y.Doc 从这儿来，协同画布的 awareness 也从这儿来。
   * 走 WebSocket 还是 HTTP 由画布的 `mode` 决定，上层不用关心。
   */
  sync: ReturnType<typeof useFlowSync>
  /** 文档级：加载 / 改名 / 复制 / 删除 */
  document: ReturnType<typeof useFlowDocument>
  /** 画布交互：Vue Flow 绑定、视口、新增节点 */
  canvas: ReturnType<typeof useFlowCanvas>
  /** 选中了哪个节点（只是个 id，不再挂任何面板） */
  selection: ReturnType<typeof useFlowSelection>
  /** 多人在场：谁在线、光标在哪、哪些元素被别人占住 */
  presence: ReturnType<typeof useFlowPresence>
}

export const FLOW_EDITOR_KEY: InjectionKey<FlowEditorContext> = Symbol("flow-editor")

/** 子组件取上下文；不在编辑器里用会直接报错，而不是拿到 undefined 到处炸 */
export function useFlowEditor(): FlowEditorContext {
  const context = inject(FLOW_EDITOR_KEY, null)
  if (!context) {
    throw new Error("useFlowEditor() 必须用在 provideFlowEditor() 的子树里")
  }
  return context
}
