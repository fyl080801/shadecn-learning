<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { ArrowLeft, Bot } from "@lucide/vue"

import { DirectorStage } from "@/components/director"
import type { DirectorShortcut } from "@/components/director/directorShortcuts"
import FlowAgentChat from "@/components/flow/agent/FlowAgentChat.vue"
import FlowAgentQuickPrompt from "@/components/flow/agent/FlowAgentQuickPrompt.vue"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DIRECTOR_AGENT_COPY, provideFlowAgentPanel } from "@/composables/flow/agent-panel"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { agentApi } from "@/lib/api"

/**
 * 全屏导演台的内容（一个节点一份，`FlowDirectorOverlay` 按节点 id 挂 / 换），和画布同一套设计语言：
 * 舞台占满整屏，控件都浮在上面 ——
 * - 左上一枚胶囊，只有两样：返回画布的图标 + 导演台节点的名字；
 * - 右上对话按钮（罗盘在它下面），底部工具栏右边快捷会话圆钮 —— 就是画布上那两个组件（`FlowAgentChat` /
 *   `FlowAgentQuickPrompt`），这里 provide 了**另一份** agent 面板：入口是这个节点（`adoptLatest: false`），
 *   文案换成导演台的。它有自己的「当前会话」，和画布对话框互不影响（docs/07 §7.5）；
 * - 有入口是本节点的任务在跑时，顶部正中一行「某某的助手正在编辑这个场景」（暂时按任务的 `nodeId`，之后换成占用）。
 *
 * 会话是普通的全局 agent（docs/20 §3.10.9）：`nodeId` 只记入口，不限制 agent 改哪个节点。
 * **打开导演台算选中这个导演台节点**（只它一个，`selection`）：新会话 / 快捷会话的空输入框开头自动带上它的提及，
 * 提及让服务端自动加载导演台技能。
 *
 * agent 随全屏层关掉而卸载：只断本地的读，服务端那一轮照跑，下次打开时接回（同画布对话框的规则）。
 *
 * **默认打开哪个会话**：我在这个节点上最近的那个（会话列表里 `mine && nodeId === 这个节点`，按 `updatedAt` 取最新）；
 * 没有就是一个新会话 —— 输入框开头放上这个节点的提及，第一条消息发出去时带 `nodeId`（服务端只记下入口）。
 * `initialPrompt`（节点底部输入框来的，开头已经补上了提及）在挑好会话之后发进去；这时不往输入框里放提及。
 */
const props = defineProps<{
  nodeId: string
  /** 打开时要发出去的那句话（节点底部输入框来的） */
  initialPrompt?: string | null
}>()

const emit = defineEmits<{ (e: "close"): void }>()

const editor = useFlowEditor()
const { store, flowId } = editor

const { agent } = provideFlowAgentPanel(editor, {
  nodeId: computed(() => props.nodeId),
  adoptLatest: false,
  copy: DIRECTOR_AGENT_COPY,
  // 打开导演台 = 选中了这个导演台节点（只它一个）
  selection: () => [props.nodeId]
})

const label = computed(() => {
  const node = store.nodeById.get(props.nodeId)
  const name = node?.metadata.label
  return typeof name === "string" && name.trim() ? name : "导演台"
})

/** 在跑的、入口是这个节点的会话的任务（任务列表上的 `nodeId`；占用功能上线后换成 `occupies`） */
const editingRuns = computed(() => agent.activeRuns.value.filter((run) => run.nodeId === props.nodeId))
const editingText = computed(() => {
  const runs = editingRuns.value
  if (runs.length === 0) return null
  const names = [...new Set(runs.map((run) => (run.mine ? "我" : run.owner.name)))]
  return `${names.join("、")}的助手正在编辑这个场景`
})

const stage = ref<InstanceType<typeof DirectorStage> | null>(null)
const chat = ref<InstanceType<typeof FlowAgentChat> | null>(null)

/** 挑会话（问一次会话列表）还没完：这期间从节点来的话先攒着 */
let picked: Promise<void> | null = null

/** 我在这个节点上最近的那个会话；没有（或列表拿不到）就是新会话 */
async function pickConversation() {
  try {
    const list = await agentApi.conversations(flowId.value)
    const mineHere = list
      .filter((item) => item.mine && item.nodeId === props.nodeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (mineHere) {
      await agent.openConversation(mineHere.id)
      return
    }
  } catch (error) {
    console.warn("[agent] 读取导演台的会话失败，按新会话处理", error)
  }
  agent.newConversation()
  // 新会话：输入框开头带上这个导演台的提及。节点底部输入框来了话就不放 —— 那句话自己带着提及发出去，输入框留空
  if (!props.initialPrompt) chat.value?.prefillMentions()
}

/** 节点底部输入框来了一句：等会话挑好，展开对话框发进当前会话 */
async function submitPrompt(text: string) {
  await picked
  await chat.value?.submit(text)
}

function runShortcut(action: DirectorShortcut): boolean {
  return stage.value?.runShortcut(action) ?? false
}

onMounted(() => {
  picked = pickConversation()
  if (props.initialPrompt) void submitPrompt(props.initialPrompt)
})

defineExpose({ submitPrompt, runShortcut })
</script>

<template>
  <div class="relative h-full w-full">
    <DirectorStage ref="stage" :node-id="nodeId" :agent-editing="editingRuns.length > 0">
      <template #top-right>
        <FlowAgentChat ref="chat" />
      </template>
      <template #toolbar-end>
        <FlowAgentQuickPrompt />
      </template>
    </DirectorStage>

    <!-- 左上：返回画布 + 节点名，只有这两样；h-10 和画布左上那排胶囊同高 -->
    <div
      class="absolute left-4 top-4 z-10 flex h-10 max-w-[min(20rem,calc(100vw-8rem))] items-center gap-1 rounded-full border bg-card/95 pl-1 pr-3 shadow-lg backdrop-blur"
    >
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0 rounded-full"
            aria-label="返回画布"
            data-testid="director-close"
            @click="emit('close')"
          >
            <ArrowLeft class="text-primary" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">返回画布（Esc）</TooltipContent>
      </Tooltip>
      <h2 class="truncate text-sm font-medium" data-testid="director-title">{{ label }}</h2>
    </div>

    <p
      v-if="editingText"
      class="absolute left-1/2 top-4 z-10 flex h-10 max-w-[40vw] -translate-x-1/2 items-center gap-1.5 truncate rounded-full border bg-card/95 px-3 text-xs text-primary shadow-lg backdrop-blur"
      data-testid="director-agent-editing"
    >
      <Bot class="size-3.5 shrink-0 motion-safe:animate-pulse" />
      {{ editingText }}
    </p>
  </div>
</template>
