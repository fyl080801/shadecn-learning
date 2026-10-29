import { inject, provide, ref, type InjectionKey, type Ref } from "vue"
import { createEventHook } from "@vueuse/core"
import { useFlowAgent, type FlowAgent } from "./useFlowAgent"

/**
 * 画布 Agent 的共享状态：一份 `useFlowAgent` + 对话框开没开。
 *
 * 入口有两个 —— 右上角的对话框（`FlowAgentChat`），和底部工具栏上的快捷输入
 * （`FlowAgentQuickPrompt`，输完直接开新会话执行）。两者必须是**同一个** agent 实例：
 * 各调一次 `useFlowAgent` 就是两条流、两份会话，快捷输入发出去的那一轮对话框里看不见。
 *
 * 不挂进 `provideFlowEditor`：agent 和画布交互无关，编辑器根视图单独 provide 一次。
 * 只 import 了 `useFlowAgent`（不碰 node-types），所以从 `components/flow/` 引它不会成环。
 */
export interface FlowAgentPanel {
  agent: FlowAgent
  /** 对话框是否展开（收起时组件仍挂着，流不断） */
  open: Ref<boolean>
  /**
   * 开一个新会话并把 `text` 作为第一条发出去，同时展开对话框。
   * 返回 `true` = 服务端接下了这一轮；`false` = 没开始（有一轮在跑、被拒、空文本）。
   */
  startConversation: (text: string) => Promise<boolean>
  /** 快捷输入新开了一轮 —— 对话框借此切回对话视图、贴底 */
  onStarted: ReturnType<typeof createEventHook<void>>["on"]
}

const FLOW_AGENT_PANEL_KEY: InjectionKey<FlowAgentPanel> = Symbol("flow-agent-panel")

/** 只能在编辑器根组件的 setup 里调用一次 */
export function provideFlowAgentPanel(flowId: Ref<string>): FlowAgentPanel {
  const agent = useFlowAgent(flowId)
  const open = ref(false)
  const started = createEventHook<void>()

  async function startConversation(text: string): Promise<boolean> {
    if (!text.trim() || agent.foreignRun.value) return false
    if (!agent.newConversation()) return false
    open.value = true
    void started.trigger()
    // send 走 useAsyncAction：失败已经 toast 过，不会 reject，没接下就是 undefined
    return (await agent.send(text)) === true
  }

  const panel: FlowAgentPanel = { agent, open, startConversation, onStarted: started.on }
  provide(FLOW_AGENT_PANEL_KEY, panel)
  return panel
}

export function useFlowAgentPanel(): FlowAgentPanel {
  const panel = inject(FLOW_AGENT_PANEL_KEY, null)
  if (!panel) {
    throw new Error("useFlowAgentPanel() 必须用在 provideFlowAgentPanel() 的子树里")
  }
  return panel
}
