<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { Bot, ChevronUp, History, LoaderCircle, MessageCircle, Sparkles, SquarePen } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useFlowAgentPanel } from "@/composables/flow/agent-panel"
import { useAsyncAction } from "@/composables/useAsyncAction"
import FlowAgentComposer from "./FlowAgentComposer.vue"
import FlowAgentHistory from "./FlowAgentHistory.vue"
import FlowAgentMessage from "./FlowAgentMessage.vue"
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 画布 Agent 的悬浮对话框（REQ-AGENT，docs/20）。
 *
 * **位置：右上角。** 左上是标题胶囊 + 在场头像，左下是视图控件 + 小地图，底部正中是工具栏。
 * 面板从按钮往下展开，高度封顶，碰不到底部工具栏。
 *
 * agent 实例和「开没开」来自 `useFlowAgentPanel()`，和底部工具栏的快捷输入共用 ——
 * 那边输完直接开新会话，这里自动展开并显示那一轮。
 *
 * 自己不定位：右上角那排（和分享按钮并列）的 `<Panel>` 在 `FlowEditor.vue` 里。
 *
 * **收起不卸载**（`v-show`）：收起时这一轮照样在跑、流照样在读、输入框里的草稿也还在；
 * 按钮上转着的圈告诉你它还没跑完。连卸载（换画布、刷新）都不会停掉服务端那一轮 ——
 * 下次打开这张画布时自动接回（`useFlowAgent`）。
 */
const { flowId } = useFlowEditor()
const { agent, open, onStarted } = useFlowAgentPanel()

const draft = ref("")
/** 面板里二选一：对话 / 历史会话列表（同一个面板里切视图，不弹新窗口） */
const view = ref<"chat" | "history">("chat")

const composer = ref<InstanceType<typeof FlowAgentComposer> | null>(null)
const list = ref<HTMLElement | null>(null)

const enabled = computed(() => agent.session.value?.enabled === true)
const messages = agent.messages

/** 本轮 assistant 那条还没出现（刚发出去、模型还没开口）时，在列表底部垫一行「思考中」 */
const waitingFirstWord = computed(() => {
  if (!agent.running.value) return false
  const last = messages.value[messages.value.length - 1]
  return !last || last.role === "user"
})

function toggle() {
  open.value = !open.value
}

// 展开（按钮或快捷输入）时贴底并聚焦输入框
watch(open, (value) => {
  if (!value) return
  void nextTick(() => {
    scrollToBottom(true)
    composer.value?.focus()
  })
})

// 快捷输入开了新会话：从历史视图切回对话，跟着新的一轮往下滚
onStarted(() => {
  view.value = "chat"
  stickToBottom = true
})

// 换画布：面板收起、草稿清空 —— 草稿里的提及指向的是上一张画布的节点
watch(flowId, () => {
  open.value = false
  draft.value = ""
  view.value = "chat"
})

// —— 自动滚到底 ——

/** 用户自己往上翻了，就别把他拽回底部；回到底部附近再恢复跟随 */
let stickToBottom = true

function onScroll() {
  const el = list.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function scrollToBottom(force = false) {
  const el = list.value
  if (!el || (!force && !stickToBottom)) return
  el.scrollTop = el.scrollHeight
  stickToBottom = true
}

// 流式文字每来一段都会变；deep 看的是消息内容，不只是条数
watch(
  messages,
  () => {
    void nextTick(() => scrollToBottom())
  },
  { deep: true }
)

// —— 动作 ——

async function send() {
  if (agent.running.value || agent.foreignRun.value) return
  const text = draft.value
  if (!text.trim()) return
  // 先清空：用户刚发的那条已经乐观地出现在列表里了，输入框里再留一份像是没发出去
  draft.value = ""
  stickToBottom = true
  const accepted = await agent.send(text)
  // 这一轮根本没开始（被拒）：把字还回去，除非用户已经又打了新的
  if (accepted !== true && draft.value === "") draft.value = text
}

function stop() {
  void agent.abort()
}

/** 发起新会话：只清前端状态，第一条消息发出去时服务端才建会话 */
function startNew() {
  if (!agent.newConversation()) return
  view.value = "chat"
  stickToBottom = true
  void nextTick(() => composer.value?.focus())
}

function toggleHistory() {
  view.value = view.value === "history" ? "chat" : "history"
}

function backToChat() {
  view.value = "chat"
  void nextTick(() => scrollToBottom(true))
}

const { run: openConversation } = useAsyncAction(
  async (id: string) => {
    // 选的就是当前会话：直接回去
    if (await agent.openConversation(id)) {
      view.value = "chat"
      stickToBottom = true
      void nextTick(() => {
        scrollToBottom(true)
        composer.value?.focus()
      })
    }
  },
  { errorMessage: "加载会话失败" }
)

/** 历史列表里删掉了当前会话 → 回到新会话空状态 */
function onDeleted(id: string) {
  if (id !== agent.conversationId.value) return
  agent.newConversation()
  view.value = "chat"
}

/**
 * 面板里的键盘事件**一律不往外冒**：画布的快捷键挂在 window 上，
 * Delete / Backspace 会删选中节点、Ctrl+Z 会撤销画布。输入框本身靠 `isEditableTarget`
 * 已经躲开了，但焦点在面板里的按钮上时按 Backspace 一样会删掉画布上的东西。
 */
function isolateKeys(event: KeyboardEvent) {
  event.stopPropagation()
}
</script>

<template>
  <!--
    nowheel / nodrag / nopan：Vue Flow 认的「这块别当成画布」标记 ——
    在面板里滚动消息列表不能变成平移画布。
  -->
  <div class="nowheel nodrag nopan relative" data-testid="agent-panel" @keydown="isolateKeys">
        <Button
          :variant="open ? 'secondary' : 'outline'"
          size="icon"
          class="relative size-10 rounded-full bg-card/95 shadow-lg backdrop-blur"
          :title="agent.running.value ? '画布 Agent（运行中）' : '画布 Agent'"
          :aria-expanded="open"
          data-testid="agent-toggle"
          @click="toggle()"
        >
          <MessageCircle class="size-5" />
          <!-- 收起时也看得出它还在跑 -->
          <span
            v-if="agent.running.value"
            class="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-background shadow"
            data-testid="agent-running-badge"
          >
            <LoaderCircle class="size-3 animate-spin text-primary" />
          </span>
        </Button>

      <!-- 挂在按钮正下方、右缘对齐：同一排左边的其他按钮（分享等）不会被它挤开 -->
      <section
        v-show="open"
        class="absolute right-0 top-full mt-2 flex h-[min(560px,calc(100vh-12rem))] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl"
        data-testid="agent-dialog"
        aria-label="画布 Agent"
      >
        <header class="flex items-center gap-2 border-b px-3 py-2">
          <Bot class="size-4 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-medium leading-5" data-testid="agent-title">
              <FlowAgentTitle v-if="agent.title.value" :text="agent.title.value" />
              <template v-else>{{ enabled ? "新会话" : "画布 Agent" }}</template>
            </h2>
          </div>
          <template v-if="enabled">
            <Button
              :variant="view === 'history' ? 'secondary' : 'ghost'"
              size="icon-xs"
              title="历史会话"
              aria-label="历史会话"
              data-testid="agent-history-toggle"
              @click="toggleHistory()"
            >
              <History />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              :title="agent.running.value ? '这一轮结束后再新建会话' : '新会话'"
              aria-label="新会话"
              :disabled="agent.running.value"
              data-testid="agent-new"
              @click="startNew()"
            >
              <SquarePen />
            </Button>
          </template>
          <Button variant="ghost" size="icon-xs" title="收起" aria-label="收起" @click="toggle()">
            <ChevronUp />
          </Button>
        </header>

        <div
          v-if="agent.loading.value && !agent.session.value"
          class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          <LoaderCircle class="mr-2 size-4 animate-spin" />
          正在加载…
        </div>

        <div
          v-else-if="agent.loadError.value"
          class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        >
          <p class="text-destructive">{{ agent.loadError.value }}</p>
          <Button variant="outline" size="sm" @click="agent.reload()">重试</Button>
        </div>

        <div
          v-else-if="!enabled"
          class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="agent-disabled"
        >
          <Bot class="size-8 text-muted-foreground" />
          <p class="text-sm font-medium">服务端未配置模型</p>
          <p class="text-xs text-muted-foreground">
            画布 Agent 暂时用不了。管理员在服务端配置好模型之后，刷新页面即可使用。
          </p>
        </div>

        <FlowAgentHistory
          v-else-if="view === 'history'"
          :flow-id="flowId"
          :current-id="agent.conversationId.value"
          :locked="agent.running.value"
          @back="backToChat()"
          @select="openConversation($event)"
          @deleted="onDeleted($event)"
        />

        <template v-else>
          <div
            ref="list"
            class="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
            data-testid="agent-messages"
            @scroll="onScroll"
          >
            <div
              v-if="messages.length === 0"
              class="m-auto max-w-64 space-y-2 text-center text-sm text-muted-foreground"
              data-testid="agent-empty"
            >
              <Sparkles class="mx-auto size-6" />
              <p class="font-medium text-foreground">让 agent 帮你改这张画布</p>
              <ul class="space-y-1 text-xs">
                <li>新建、删除节点和连线</li>
                <li>改写节点里的文字内容</li>
                <li>输入 <kbd class="rounded border px-1 font-mono">@</kbd> 提及节点，指定要改哪一个</li>
              </ul>
            </div>

            <FlowAgentMessage
              v-for="(message, index) in messages"
              :key="message.id"
              :message="message"
              :streaming="agent.running.value && index === messages.length - 1"
            />

            <p v-if="waitingFirstWord" class="text-sm text-muted-foreground">思考中…</p>
          </div>

          <!-- 别人发起的一轮：看不到内容，只说是谁；结束后（轮询到）自动解除 -->
          <div
            v-if="agent.foreignRun.value"
            class="flex items-center gap-2 border-t bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
            data-testid="agent-foreign-run"
          >
            <LoaderCircle class="size-3 shrink-0 animate-spin" />
            <span class="flex-1">{{ agent.foreignRun.value.initiator.name }} 发起的 agent 正在运行</span>
          </div>

          <div class="border-t p-3">
            <FlowAgentComposer
              ref="composer"
              v-model="draft"
              :running="agent.running.value"
              :locked="agent.foreignRun.value !== null"
              :aborting="agent.aborting.value"
              @send="send()"
              @stop="stop()"
            />
          </div>
        </template>
      </section>
  </div>
</template>
