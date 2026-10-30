<script setup lang="ts">
import { computed, ref } from "vue"
import { Bot, PanelRightClose, PanelRightOpen, X } from "@lucide/vue"

import { DirectorStage } from "@/components/director"
import type { DirectorShortcut } from "@/components/director/directorShortcuts"
import FlowDirectorAgentPanel from "@/components/flow/agent/FlowDirectorAgentPanel.vue"
import { Button } from "@/components/ui/button"
import { useHostFlowAgent } from "@/composables/flow/agent-panel"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 全屏导演台的内容（一个节点一份，`FlowDirectorOverlay` 按节点 id 挂 / 换）：
 * 顶栏（名字、「某某的助手正在编辑这个场景」、对话面板开关、关闭）+ 舞台（视口 + 时间轴）+ 可收起的对话面板。
 *
 * 对话面板的 agent 是**这一份**（绑定这个节点，`adoptLatest: false`），随全屏层关掉而卸载：只断本地的读，
 * 服务端那一轮照跑，下次打开时接回（同画布对话框的规则）。
 */
const props = defineProps<{
  nodeId: string
  /** 打开时要发出去的那句话（节点底部输入框来的） */
  initialPrompt?: string | null
}>()

const emit = defineEmits<{ (e: "close"): void }>()

const editor = useFlowEditor()
const { store, flowId } = editor

const agent = useHostFlowAgent(editor, { nodeId: computed(() => props.nodeId), adoptLatest: false })

const label = computed(() => {
  const node = store.nodeById.get(props.nodeId)
  const name = node?.metadata.label
  return typeof name === "string" && name.trim() ? name : "导演台"
})

/** 在跑的、属于绑定这个节点的会话的任务（任务列表上的 `nodeId`） */
const editingRuns = computed(() => agent.activeRuns.value.filter((run) => run.nodeId === props.nodeId))
const editingText = computed(() => {
  const runs = editingRuns.value
  if (runs.length === 0) return null
  const names = [...new Set(runs.map((run) => (run.mine ? "我" : run.owner.name)))]
  return `${names.join("、")}的助手正在编辑这个场景`
})

const panelOpen = ref(true)
const stage = ref<InstanceType<typeof DirectorStage> | null>(null)
const panel = ref<InstanceType<typeof FlowDirectorAgentPanel> | null>(null)

/** 已经开着时又从节点底部输入框来了一句：展开面板，发出去 */
function submitPrompt(text: string) {
  panelOpen.value = true
  void panel.value?.submit(text)
}

function runShortcut(action: DirectorShortcut): boolean {
  return stage.value?.runShortcut(action) ?? false
}

defineExpose({ submitPrompt, runShortcut })
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4 text-card-foreground">
      <h2 class="truncate text-sm font-medium" data-testid="director-title">{{ label }}</h2>
      <p
        v-if="editingText"
        class="flex min-w-0 items-center gap-1.5 truncate rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary"
        data-testid="director-agent-editing"
      >
        <Bot class="size-3.5 shrink-0 motion-safe:animate-pulse" />
        {{ editingText }}
      </p>
      <div class="flex-1" />
      <Button
        variant="ghost"
        size="icon-sm"
        :aria-label="panelOpen ? '收起助手面板' : '展开助手面板'"
        :aria-pressed="panelOpen"
        data-testid="director-panel-toggle"
        @click="panelOpen = !panelOpen"
      >
        <PanelRightClose v-if="panelOpen" />
        <PanelRightOpen v-else />
      </Button>
      <Button
        variant="secondary"
        size="icon-sm"
        class="rounded-full"
        aria-label="关闭导演台"
        data-testid="director-close"
        @click="emit('close')"
      >
        <X />
      </Button>
    </header>

    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1">
        <DirectorStage ref="stage" :node-id="nodeId" :agent-editing="editingRuns.length > 0" />
      </div>
      <!-- 收起不卸载（v-show）：这一轮照样在跑、流照样在读、输入框里的草稿也还在 -->
      <aside v-show="panelOpen" class="w-[360px] max-w-[40vw] shrink-0 border-l">
        <FlowDirectorAgentPanel
          ref="panel"
          :agent="agent"
          :flow-id="flowId"
          :node-id="nodeId"
          :initial-prompt="initialPrompt ?? null"
        />
      </aside>
    </div>
  </div>
</template>
