<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue"
import { toast } from "vue-sonner"
import { ArrowDown, Bot, Eye, Sparkles, SquarePen } from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport
} from "@/components/ui/message-scroller"
import { provideMessageScroller } from "@/components/ui/message-scroller/useMessageScroller"
import { Spinner } from "@/components/ui/spinner"
import type { FlowAgent } from "@/composables/flow/useFlowAgent"
import { agentApi } from "@/lib/api"
import FlowAgentComposer from "./FlowAgentComposer.vue"
import FlowAgentMessage from "./FlowAgentMessage.vue"
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 导演台全屏层里的对话面板（docs/07 §7.5）：全屏层盖住了画布右上角的对话入口，所以导演台里有自己的一份。
 *
 * - 用的是**另一份** agent（`useHostFlowAgent(…, { nodeId, adoptLatest: false })`，由全屏层建）：
 *   它的「当前会话」是绑定这个导演台的会话，和画布对话框互不影响。
 * - **默认打开哪个会话**：我在这个节点上最近的那个（会话列表里 `mine && nodeId === 这个节点`，按 `updatedAt` 取最新）；
 *   没有就是一个新会话 —— 第一条消息发出去时带 `nodeId`，服务端把它建成节点范围会话。
 * - 消息、输入框、停止复用画布对话框的组件（`FlowAgentMessage` / `FlowAgentComposer`）。
 * - `initialPrompt`：从节点底部输入框来的那句话，挑好会话之后直接发出去（会话正在跑就放进输入框、提示一声）。
 */
const props = defineProps<{
  agent: FlowAgent
  flowId: string
  nodeId: string
  initialPrompt?: string | null
}>()

const agent = props.agent
const draft = ref("")
const composer = ref<InstanceType<typeof FlowAgentComposer> | null>(null)
const scroller = provideMessageScroller({ autoScroll: true, defaultScrollPosition: "end" })

/** 挑会话（问一次会话列表）还没完 */
const picking = ref(true)

const enabled = computed(() => agent.session.value?.enabled === true)
const messages = agent.messages
const waitingFirstWord = computed(() => {
  if (!agent.running.value) return false
  const last = messages.value[messages.value.length - 1]
  return !last || last.role !== "assistant"
})

function followToEnd() {
  scroller.context.scrollToEnd({ behavior: "auto" })
}

/** 我在这个节点上最近的那个会话；没有（或列表拿不到）就是新会话 */
async function pickConversation() {
  try {
    const list = await agentApi.conversations(props.flowId)
    const bound = list
      .filter((item) => item.mine && item.nodeId === props.nodeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (bound) {
      await agent.openConversation(bound.id)
      return
    }
  } catch (error) {
    console.warn("[agent] 读取导演台的会话失败，按新会话处理", error)
  }
  agent.newConversation()
}

/**
 * 在当前（绑定这个节点的）会话里发一句话。会话正在跑、或者是别人的（不会挑到，防御一下）：放进输入框、提示一声。
 * 返回 true = 服务端接下了这一轮
 */
async function submit(text: string): Promise<boolean> {
  const prompt = text.trim()
  if (!prompt) return false
  if (agent.running.value || !agent.mine.value) {
    draft.value = draft.value ? `${draft.value}\n${prompt}` : prompt
    toast.info("这个导演台的会话里有一轮正在跑，等它结束再发（已放进输入框）")
    return false
  }
  void nextTick(followToEnd)
  const accepted = await agent.send(prompt)
  // 这一轮根本没开始（被拒）：把字放回输入框，除非用户已经又打了新的
  if (accepted !== true && draft.value === "") draft.value = prompt
  return accepted === true
}

async function send() {
  const text = draft.value
  if (!text.trim() || agent.running.value || !agent.mine.value) return
  // 先清空：刚发的那条已经乐观地出现在列表里了
  draft.value = ""
  await submit(text)
}

function stop() {
  void agent.abort()
}

/** 新开一个绑定这个导演台的会话（第一条消息发出去时服务端才建） */
function startNew() {
  agent.newConversation()
  void nextTick(() => {
    followToEnd()
    composer.value?.focus()
  })
}

onMounted(async () => {
  await pickConversation()
  picking.value = false
  if (props.initialPrompt) await submit(props.initialPrompt)
})

defineExpose({
  submit,
  focus: () => composer.value?.focus()
})
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-col bg-card text-card-foreground"
    aria-label="导演台助手"
    data-testid="director-agent-panel"
  >
    <header class="flex items-center gap-2 border-b px-3 py-2">
      <Bot class="size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <h2 class="flex min-w-0 items-center gap-1 text-sm font-medium leading-5" data-testid="director-agent-title">
          <FlowAgentTitle v-if="agent.title.value" :text="agent.title.value" class="min-w-0 flex-1" />
          <template v-else>新会话</template>
        </h2>
        <ul v-if="agent.skills.value.length > 0" class="mt-1 flex flex-wrap gap-1" aria-label="已加载的技能">
          <li v-for="skill in agent.skills.value" :key="skill.id">
            <Badge variant="secondary" class="px-1.5 py-0 text-[10px] font-normal">{{ skill.title }}</Badge>
          </li>
        </ul>
      </div>
      <Button
        v-if="enabled"
        variant="ghost"
        size="icon-xs"
        aria-label="新会话"
        title="新开一个绑定这个导演台的会话"
        data-testid="director-agent-new"
        @click="startNew()"
      >
        <SquarePen />
      </Button>
    </header>

    <div
      v-if="picking || (agent.loading.value && !agent.session.value)"
      class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
    >
      <Spinner class="mr-2" />
      正在加载…
    </div>

    <div
      v-else-if="agent.loadError.value"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
    >
      <p class="text-destructive">{{ agent.loadError.value }}</p>
      <Button variant="outline" size="sm" @click="agent.reload()">重试</Button>
    </div>

    <Empty v-else-if="!enabled" class="gap-2 p-6 md:p-6" data-testid="director-agent-disabled">
      <EmptyHeader class="gap-2">
        <EmptyMedia class="mb-0 text-muted-foreground">
          <Bot class="size-8" />
        </EmptyMedia>
        <EmptyTitle class="text-sm">服务端未配置模型</EmptyTitle>
        <EmptyDescription class="text-xs">导演台助手暂时用不了。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <MessageScroller class="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="对话消息" data-testid="director-agent-messages">
          <MessageScrollerContent class="gap-3 px-3 py-3">
            <Empty v-if="messages.length === 0" class="m-auto max-w-64 flex-none gap-2 p-0 md:p-0">
              <EmptyHeader>
                <EmptyMedia class="mb-0 text-muted-foreground">
                  <Sparkles class="size-6" />
                </EmptyMedia>
                <EmptyTitle class="text-sm">让助手搭这个场景</EmptyTitle>
                <EmptyDescription class="text-xs">
                  摆放几何体、机位和灯光，编排移动、旋转、缩放的动画。这个会话只改这个导演台。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
            <MessageScrollerItem v-for="(message, index) in messages" :key="message.id" :message-id="message.id">
              <FlowAgentMessage :message="message" :streaming="agent.running.value && index === messages.length - 1" />
            </MessageScrollerItem>
            <p v-if="waitingFirstWord" class="text-sm text-muted-foreground">思考中…</p>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton size="icon-xs" class="data-[direction=end]:bottom-3">
          <ArrowDown />
          <span class="sr-only">回到底部</span>
        </MessageScrollerButton>
      </MessageScroller>

      <div class="border-t p-3">
        <FlowAgentComposer
          v-if="agent.mine.value"
          ref="composer"
          v-model="draft"
          :running="agent.running.value"
          :aborting="agent.aborting.value"
          placeholder="让助手改这个场景…（回车发送）"
          hide-quote
          @send="send()"
          @stop="stop()"
        />
        <div v-else class="flex items-center gap-2 text-xs text-muted-foreground">
          <Eye class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1">这是 {{ agent.owner.value?.name ?? "别人" }} 的会话，只能查看</span>
          <Button size="xs" @click="startNew()">
            <SquarePen />
            发起新会话
          </Button>
        </div>
      </div>
    </template>
  </section>
</template>
