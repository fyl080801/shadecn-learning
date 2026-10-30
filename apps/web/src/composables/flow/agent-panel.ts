import { computed, inject, provide, ref, watch, type InjectionKey, type Ref } from "vue"
import { createEventHook } from "@vueuse/core"
import type { FlowSummary } from "@shadecn/shared/canvas"
import { projectApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useFlowAgent, type FlowAgent, type FlowAgentChannel, type FlowAgentOptions } from "./useFlowAgent"

/**
 * 画布 Agent 的共享状态：一份 `useFlowAgent` + 对话框开没开 + 面板上的文案。
 *
 * 入口有两个 —— 右上角的对话框（`FlowAgentChat`），和底部工具栏上的快捷输入
 * （`FlowAgentQuickPrompt`，输完直接开新会话执行）。两者必须是**同一个** agent 实例：
 * 各调一次 `useFlowAgent` 就是两条流、两份会话，快捷输入发出去的那一轮对话框里看不见。
 *
 * 导演台全屏层在自己的子树里**再 provide 一份**（绑定那个节点，docs/07 §7.5）：同样两个组件挂在导演台的
 * 右上角和底部工具栏上，读到的是导演台这一份，和画布那份互不影响。
 *
 * 不挂进 `provideFlowEditor`：agent 和画布交互无关，编辑器根视图单独 provide 一次。
 * 只 import 了 `useFlowAgent`（不碰 node-types），所以从 `components/flow/` 引它不会成环。
 */
/** 对话框 / 快捷输入上随场景变的文字（画布、导演台各一套） */
export interface FlowAgentPanelCopy {
  /** 按钮、面板的名字 */
  name: string
  emptyTitle: string
  /** 空会话下的一句说明；null = 画布那份（新建删除节点、@ 提及节点的提示列表） */
  emptyDescription: string | null
  /** 快捷输入按钮的说明 */
  quickTitle: string
  /** 输入框占位；不给用输入框自己的 */
  placeholder?: string
  /** 不显示「引用画布上选中的节点」（导演台里没有画布选区） */
  hideQuote?: boolean
}

export const CANVAS_AGENT_COPY: FlowAgentPanelCopy = {
  name: "画布 Agent",
  emptyTitle: "让 agent 帮你改这张画布",
  emptyDescription: null,
  quickTitle: "让 agent 改画布（新会话）"
}

export const DIRECTOR_AGENT_COPY: FlowAgentPanelCopy = {
  name: "导演台助手",
  emptyTitle: "让助手搭这个场景",
  emptyDescription: "摆放几何体、机位和灯光，编排移动、旋转、缩放的动画。这个会话只改这个导演台。",
  quickTitle: "让助手改这个场景（新会话）",
  placeholder: "让助手改这个场景…（回车发送）",
  hideQuote: true
}

export interface FlowAgentPanel {
  agent: FlowAgent
  copy: FlowAgentPanelCopy
  /** 对话框是否展开（收起时组件仍挂着，流不断） */
  open: Ref<boolean>
  /**
   * 开一个新会话并把 `text` 作为第一条发出去，同时展开对话框。别的任务在跑不挡它（docs/20 §3.10.3）。
   * 返回 `true` = 服务端接下了这一轮；`false` = 没开始（被拒、空文本）。
   */
  startConversation: (text: string) => Promise<boolean>
  /** 快捷输入新开了一轮 —— 对话框借此切回对话视图、贴底 */
  onStarted: ReturnType<typeof createEventHook<void>>["on"]
}

/** 编辑器上下文里这里用得到的那几样（测试可以只给这些） */
export interface FlowAgentHost {
  flowId: Ref<string>
  store: { readonly meta: FlowSummary | null }
  sync: FlowAgentChannel
}

const FLOW_AGENT_PANEL_KEY: InjectionKey<FlowAgentPanel> = Symbol("flow-agent-panel")

/**
 * 按编辑器上下文建一份 `useFlowAgent`（画布元信息、当前用户、项目角色、任务列表推送都接好）。
 *
 * 画布的对话框只能有一份（`provideFlowAgentPanel`）；导演台全屏层的对话面板是**另一份**（绑定那个节点，
 * docs/07 §7.5）：它有自己的「当前会话」，切会话不该把画布对话框也切走。两份各自读各自的流，任务列表都来自同一条推送。
 */
export function useHostFlowAgent(
  host: FlowAgentHost,
  extra: Pick<FlowAgentOptions, "nodeId" | "adoptLatest"> = {}
): FlowAgent {
  const { flowId, store, sync } = host
  /** 元信息对上了这张画布才算数（换画布时 `store.meta` 会先留着上一张的，同 `context.ts`） */
  const meta = computed(() => (store.meta && store.meta.id === flowId.value ? store.meta : null))
  const mode = computed(() => meta.value?.mode ?? null)

  const { user } = useAuth()
  const isAdmin = useProjectAdmin(computed(() => (meta.value?.mode === "collab" ? meta.value.projectId : null)))

  return useFlowAgent(flowId, {
    mode,
    user: computed(() => {
      const current = user.value
      return current ? { id: current.id, name: current.name ?? current.username, avatarUrl: current.avatarUrl } : null
    }),
    isAdmin,
    channel: sync,
    ...extra
  })
}

/**
 * 画布那份只能在编辑器根组件的 setup 里调用一次；导演台全屏层给 `nodeId` 再调一次，
 * 只覆盖它自己的子树
 */
export function provideFlowAgentPanel(
  host: FlowAgentHost,
  options: Pick<FlowAgentOptions, "nodeId" | "adoptLatest"> & { copy?: FlowAgentPanelCopy } = {}
): FlowAgentPanel {
  const { copy = CANVAS_AGENT_COPY, ...extra } = options
  const agent = useHostFlowAgent(host, extra)
  const open = ref(false)
  const started = createEventHook<void>()

  async function startConversation(text: string): Promise<boolean> {
    if (!text.trim()) return false
    agent.newConversation()
    open.value = true
    void started.trigger()
    // send 走 useAsyncAction：失败已经 toast 过，不会 reject，没接下就是 undefined
    return (await agent.send(text)) === true
  }

  const panel: FlowAgentPanel = { agent, copy, open, startConversation, onStarted: started.on }
  provide(FLOW_AGENT_PANEL_KEY, panel)
  return panel
}

/**
 * 我在这个项目里是不是管理员（`ProjectSummary.myRole`）—— 只用来决定显不显示「停止别人的一轮」。
 * 画布元信息里没有角色，所以问一次项目详情；拿不到就当不是：少一个按钮，服务端照样把关（403）。
 * 个人画布不问（`projectId` 给 null）：那里只有自己的会话。
 */
function useProjectAdmin(projectId: Ref<string | null>): Ref<boolean> {
  const isAdmin = ref(false)
  let seq = 0
  watch(
    projectId,
    async (id) => {
      const ticket = ++seq
      isAdmin.value = false
      if (!id) return
      try {
        const project = await projectApi.get(id)
        if (ticket === seq) isAdmin.value = project.myRole === "admin"
      } catch (error) {
        console.warn("[agent] 读取项目角色失败，按普通成员处理", error)
      }
    },
    { immediate: true }
  )
  return isAdmin
}

export function useFlowAgentPanel(): FlowAgentPanel {
  const panel = inject(FLOW_AGENT_PANEL_KEY, null)
  if (!panel) {
    throw new Error("useFlowAgentPanel() 必须用在 provideFlowAgentPanel() 的子树里")
  }
  return panel
}
