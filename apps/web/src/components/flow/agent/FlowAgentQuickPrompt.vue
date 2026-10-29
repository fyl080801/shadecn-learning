<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { Sparkles } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useFlowAgentPanel } from "@/composables/flow/agent-panel"
import FlowAgentComposer from "./FlowAgentComposer.vue"

/**
 * 底部工具栏右侧的 agent 快捷入口（独立深色圆钮，不在胶囊里）：点开弹出一个输入框，发出去就**开一个新会话**执行，
 * 右上角的对话框随之展开、显示这一轮。
 *
 * 不在这里续聊 —— 续聊、看历史、停止都在对话框里；这里只负责「起一个头」。
 * 输入框和对话框底部是同一个 `FlowAgentComposer`（含 @ 提及节点、引用选中）。
 */
const { flowId } = useFlowEditor()
const { agent, startConversation } = useFlowAgentPanel()

const open = ref(false)
const draft = ref("")
const composer = ref<InstanceType<typeof FlowAgentComposer> | null>(null)

const enabled = computed(() => agent.session.value?.enabled === true)

/** 已有一轮在跑（自己的或别人的）：不能新开，提示去对话框里看 */
const busy = computed(() => agent.running.value || agent.foreignRun.value !== null)

const title = computed(() => {
  if (agent.session.value && !enabled.value) return "画布 Agent（服务端未配置模型）"
  return "让 agent 改画布（新会话）"
})

watch(open, (value) => {
  if (value) void nextTick(() => composer.value?.focus())
})

// 换画布：收起、草稿清空 —— 草稿里的提及指向的是上一张画布的节点
watch(flowId, () => {
  open.value = false
  draft.value = ""
})

async function send() {
  const text = draft.value
  if (!text.trim() || busy.value) return
  draft.value = ""
  open.value = false
  const accepted = await startConversation(text)
  // 根本没开始：把字还回去，除非用户已经又打了新的
  if (!accepted && draft.value === "") draft.value = text
}

/**
 * 提及列表被 PromptInput teleport 到 body，在弹层**外面** —— 点里面的选项
 * 不能当成「点了外面」把弹层关掉。
 */
function onInteractOutside(event: Event) {
  const target = event.target as Element | null
  if (target?.closest('[data-testid="agent-mention-menu"]')) event.preventDefault()
}

/** 弹层里的按键不往外冒（画布快捷键挂在 window 上）；Esc 留给弹层自己关 */
function isolateKeys(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation()
}
</script>

<template>
  <Popover v-model:open="open">
    <!--
      外圈流光：一层转动的锥形渐变（400 色阶，比纯色柔、比浅色显眼），模糊后垫在按钮下面，带一点朦胧感。
      范围和工具栏胶囊同高 —— 胶囊 46px、按钮 32px，四周外扩 7px；模糊会再往外晕开一点，
      所以实体只扩 6px，晕开后大致落在 46px 上。
      不可用（没配模型）时不发光；系统开了「减少动态效果」就停转。
    -->
    <span class="relative inline-flex">
      <span
        v-if="enabled"
        aria-hidden="true"
        class="pointer-events-none absolute -inset-[6px] overflow-hidden rounded-full opacity-90 blur-[4px]"
      >
        <span
          class="absolute inset-[-50%] animate-[spin_3s_linear_infinite] bg-[conic-gradient(from_0deg,#c084fc,#60a5fa,#22d3ee,#f472b6,#c084fc)] motion-reduce:animate-none"
        />
      </span>
      <PopoverTrigger as-child>
        <!--
          和胶囊里的按钮同尺寸（32px）。阴影加深到 black/30：默认的 black/10 压在深色按钮底下
          和按钮同色，看不出投影；胶囊靠的是白底 + 边框才显得出来。
        -->
        <Button
          size="icon"
          class="relative size-8 rounded-full shadow-lg shadow-black/30"
          :title="title"
          :aria-label="title"
          :disabled="!enabled"
          data-testid="agent-quick-toggle"
        >
          <Sparkles />
        </Button>
      </PopoverTrigger>
    </span>
    <PopoverContent
      side="top"
      align="center"
      :side-offset="12"
      class="nowheel w-[420px] max-w-[calc(100vw-2rem)] p-3"
      data-testid="agent-quick-prompt"
      @interact-outside="onInteractOutside"
      @keydown="isolateKeys"
    >
      <p
        v-if="busy"
        class="mb-2 text-xs text-muted-foreground"
        data-testid="agent-quick-busy"
      >
        已有一轮在运行，结束后才能开新会话（进度在右上角对话框里）
      </p>
      <!-- 有一轮在跑时锁住发送；停止在对话框里，这里不放 -->
      <FlowAgentComposer
        ref="composer"
        v-model="draft"
        :running="false"
        :locked="busy"
        :aborting="false"
        @send="send()"
      />
    </PopoverContent>
  </Popover>
</template>
