<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { toast } from "vue-sonner"
import {
  ArrowDown,
  Bot,
  ChevronUp,
  Eye,
  History,
  ListChecks,
  MessageCircle,
  Sparkles,
  Square,
  SquarePen
} from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport
} from "@/components/ui/message-scroller"
import { provideMessageScroller } from "@/components/ui/message-scroller/useMessageScroller"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useFlowAgentPanel } from "@/composables/flow/agent-panel"
import { useAssetUploadList } from "@/composables/useAssetUpload"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { AGENT_ATTACHMENT_LIMIT, attachmentsOf } from "./attachments"
import FlowAgentComposer from "./FlowAgentComposer.vue"
import FlowAgentHistory from "./FlowAgentHistory.vue"
import FlowAgentMessage from "./FlowAgentMessage.vue"
import FlowAgentTasks from "./FlowAgentTasks.vue"
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 画布 Agent 的悬浮对话框（REQ-AGENT，docs/20 §3.10.4–§3.10.5）。
 *
 * **位置：右上角。** 左上是标题胶囊 + 在场头像，左下是视图控件 + 小地图，底部正中是工具栏。
 * 面板从按钮往下展开，高度封顶，碰不到底部工具栏。自己不定位：右上角那排（和分享按钮并列）的
 * `<Panel>` 在 `FlowEditor.vue` 里。
 *
 * agent 实例和「开没开」来自 `useFlowAgentPanel()`，和底部工具栏的快捷输入共用 ——
 * 那边输完直接开新会话，这里自动展开并显示那一轮。
 *
 * - **按钮**：这张画布上有任务在跑时外圈转一个环、右上角挂任务数（项目画布是所有成员的，个人画布只有自己的）。
 *   系统开了「减少动态效果」就只留角标。
 * - **面板三个视图**：对话 / 历史会话 / 进行中的任务。点开按钮时：当前会话就是一个在跑的任务 → 留在对话；
 *   ≥2 个任务 → 先列任务；只有 1 个 → 直接进它，除非我正在自己的某个会话里（不把人从自己的对话里拽走）。
 * - 技能（docs/23 §3.6）：对话里每次加载有一行「已加载：…」；输入框上方不列已加载的技能。
 * - **附件**（docs/20 §3.10.12）：输入区上方的附件列表（`useAssetUploadList`，本组件建、交给输入区画）。
 *   发送时摘走，这一轮没开始就和文字一起还回去；换画布时清空（列表自己跟着 `flowId` 清）。
 * - **别人的会话只读**（项目画布）：头部「张三 · 标题」，输入框换成一行说明 + 「发起新会话」；
 *   在跑的话看得到实时进度，停止按钮只给项目管理员。
 *
 * **消息列表是 shadcn 的 `message-scroller`**：贴底跟随流式输出，用户往上翻就停，翻回底部恢复跟随，
 * 离开底部时出现「回到底部」按钮。provider 在本组件里建，面板自己的动作（发送、换会话）才能调 `scrollToEnd`。
 *
 * **收起不卸载**（`v-show`）：收起时这一轮照样在跑、流照样在读、输入框里的草稿也还在。
 * 连卸载（换画布、刷新）都不会停掉服务端那一轮 —— 下次打开这张画布时自动接回（`useFlowAgent`）。
 *
 * 导演台全屏层右上角也是这个组件：它读到的是导演台 provide 的那一份（入口是那个节点，文案换成导演台的，docs/07 §7.5），
 * 节点底部输入框来的话经 `submit` 发进当前会话。
 *
 * **点「新会话」时输入框为空，就在开头放上选中节点的提及**（`selectionMentions`，docs/20 §3.10.9）；已有草稿不动，续聊不加。
 * 导演台默认打开的是新会话时同样放（`prefillMentions`，由导演台在挑会话时调）。
 */
const { flowId } = useFlowEditor()
const { agent, copy, open, onStarted, onShowConversation, selectionMentions } = useFlowAgentPanel()

const draft = ref("")
/** 这条消息的附件：传到这张画布的资源，随消息发给 agent */
const attachments = useAssetUploadList(flowId, { max: AGENT_ATTACHMENT_LIMIT })
/** 面板里三选一：对话 / 历史会话列表 / 进行中的任务（同一个面板里切视图，不弹新窗口） */
const view = ref<"chat" | "history" | "tasks">("chat")

const composer = ref<InstanceType<typeof FlowAgentComposer> | null>(null)
const scroller = provideMessageScroller({ autoScroll: true, defaultScrollPosition: "end" })

const enabled = computed(() => agent.session.value?.enabled === true)
const messages = agent.messages
const runCount = computed(() => agent.activeRuns.value.length)
const toggleLabel = computed(() =>
  runCount.value > 0 ? `${copy.name}（${runCount.value} 个任务运行中）` : copy.name
)
/** 别人的会话（只读）的发起人；自己的 / 新会话为 null */
const foreignOwner = computed(() => (agent.mine.value ? null : agent.owner.value))

/**
 * 本轮 assistant 那条还没出现（刚发出去、模型还没开口）时，在列表底部垫一行「思考中」。
 * 末尾是画布改动通知（跨轮差异紧跟用户消息）也算还没开口
 */
const waitingFirstWord = computed(() => {
  if (!agent.running.value) return false
  const last = messages.value[messages.value.length - 1]
  return !last || last.role !== "assistant"
})

function toggle() {
  open.value = !open.value
  if (open.value) pickOpeningView()
}

/** 点开面板时落在哪（规则见文件头）。只在点按钮时判断 —— 快捷输入展开的就是它刚开的那一轮 */
function pickOpeningView() {
  const runs = agent.activeRuns.value
  if (!enabled.value || runs.length === 0) return
  const current = agent.conversationId.value
  if (current && runs.some((run) => run.conversationId === current)) return
  if (runs.length >= 2) {
    view.value = "tasks"
    return
  }
  const [only] = runs
  if (!only || (current && agent.mine.value)) return
  void openConversation(only.conversationId)
}

// 展开（按钮或快捷输入）时贴底并聚焦输入框
watch(open, (value) => {
  if (!value) return
  void nextTick(() => {
    followToEnd()
    composer.value?.focus()
  })
})

// 快捷输入开了新会话：从别的视图切回对话，跟着新的一轮往下滚
onStarted(() => {
  view.value = "chat"
  void nextTick(followToEnd)
})

// 换画布：面板收起、草稿清空 —— 草稿里的提及指向的是上一张画布的节点
watch(flowId, () => {
  open.value = false
  draft.value = ""
  view.value = "chat"
})

/**
 * 滚到底并恢复跟随（用户之前往上翻过也一样）。之后内容再变高由 scroller 自己跟，不用 watch 消息。
 * 消息列表在 `v-else` 里，切回对话视图的同一拍还没挂上 —— 调用方在 nextTick 里调
 */
function followToEnd() {
  scroller.context.scrollToEnd({ behavior: "auto" })
}

// —— 动作 ——

async function send() {
  if (agent.running.value || !agent.mine.value) return
  // 附件还在传 / 传失败了：输入区已经不让发，这里再挡一次
  if (attachments.uploading || attachments.failed) return
  const text = draft.value
  if (!text.trim() && attachments.ready.length === 0) return
  // 先清空：用户刚发的那条已经乐观地出现在列表里了，输入框里再留一份像是没发出去
  draft.value = ""
  const items = attachments.detach()
  followToEnd()
  const accepted = await agent.send(text, attachmentsOf(items))
  if (accepted === true) {
    attachments.release(items)
    return
  }
  // 这一轮根本没开始（被拒）：把字和附件还回去（字只在用户没又打新的时还）
  if (draft.value === "") draft.value = text
  attachments.restore(items)
}

function stop() {
  void agent.abort()
}

/**
 * 外面递来一句话，发进**当前**会话（导演台节点底部输入框来的）：展开面板、切回对话。
 * 当前会话正在跑、或者是别人的：放进输入框、提示一声。返回 true = 服务端接下了这一轮
 */
async function submit(text: string): Promise<boolean> {
  const prompt = text.trim()
  if (!prompt) return false
  open.value = true
  view.value = "chat"
  if (agent.running.value || !agent.mine.value) {
    draft.value = draft.value ? `${draft.value}\n${prompt}` : prompt
    toast.info("当前会话里有一轮正在跑，等它结束再发（已放进输入框）")
    return false
  }
  void nextTick(followToEnd)
  const accepted = await agent.send(prompt)
  // 这一轮根本没开始（被拒）：把字放回输入框，除非用户已经又打了新的
  if (accepted !== true && draft.value === "") draft.value = prompt
  return accepted === true
}

/** 新会话的空输入框开头放上选中节点的提及；已有草稿不动 */
function prefillMentions() {
  if (draft.value === "") draft.value = selectionMentions()
}

defineExpose({ submit, prefillMentions })

/** 发起新会话：只清前端状态，第一条消息发出去时服务端才建会话；当前会话在跑也行（那一轮照跑） */
function startNew() {
  agent.newConversation()
  prefillMentions()
  view.value = "chat"
  void nextTick(() => {
    followToEnd()
    composer.value?.focus()
  })
}

function toggleView(target: "history" | "tasks") {
  view.value = view.value === target ? "chat" : target
}

function backToChat() {
  view.value = "chat"
  void nextTick(followToEnd)
}

const { run: openConversation } = useAsyncAction(
  async (id: string) => {
    // 选的就是当前会话：直接回去
    if (await agent.openConversation(id)) {
      view.value = "chat"
      void nextTick(() => {
        followToEnd()
        composer.value?.focus()
      })
    }
  },
  { errorMessage: "加载会话失败" }
)

// 节点上的占用标签点进来：展开（showConversation 已经展开了）并打开那个会话
onShowConversation((id) => {
  void openConversation(id)
})

/** 历史列表里删掉了当前会话 → 回到新会话空状态 */
function onDeleted(id: string) {
  if (id !== agent.conversationId.value) return
  agent.newConversation()
  view.value = "chat"
}

/**
 * 面板里的键盘事件**不往外冒**：画布的快捷键挂在 window 上，
 * Delete / Backspace 会删选中节点、Ctrl+Z 会撤销画布。输入框本身靠 `isEditableTarget`
 * 已经躲开了，但焦点在面板里的按钮上时按 Backspace 一样会删掉画布上的东西。
 * Esc 除外：导演台全屏层靠它让输入框失焦（docs/07 §7.6），画布的快捷键不认 Esc。
 */
function isolateKeys(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation()
}
</script>

<template>
  <!--
    nowheel / nodrag / nopan：Vue Flow 认的「这块别当成画布」标记 ——
    在面板里滚动消息列表不能变成平移画布。
  -->
  <div class="nowheel nodrag nopan relative" data-testid="agent-panel" @keydown="isolateKeys">
      <span class="relative inline-flex">
        <!--
          有任务在跑：沿按钮边缘转一个环，和按钮同尺寸、盖在按钮自己的边框上（z-10），不往外扩；
          减少动态效果时整个不画，只留角标
        -->
        <span
          v-if="runCount > 0"
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 z-10 rounded-full border-2 border-primary/20 border-t-primary motion-safe:animate-spin motion-reduce:hidden"
          data-testid="agent-run-ring"
        />
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              :variant="open ? 'secondary' : 'outline'"
              size="icon"
              class="relative size-10 rounded-full bg-card/95 shadow-lg backdrop-blur"
              :aria-label="toggleLabel"
              :aria-expanded="open"
              data-testid="agent-toggle"
              @click="toggle()"
            >
              <MessageCircle class="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ toggleLabel }}</TooltipContent>
        </Tooltip>
        <!--
          运行中任务数：收起时也看得出有几轮在跑。放在按钮外、相对外层定位 —— 按钮开 / 合会在
          outline（有边框）和 secondary（无边框）之间切换并带过渡，挂在按钮里会跟着边框宽度飘。
        -->
        <Badge
          v-if="runCount > 0"
          as="span"
          aria-hidden="true"
          class="pointer-events-none absolute -right-1 -top-1 z-20 h-4 min-w-4 px-1 py-0 text-[10px] font-semibold leading-none tabular-nums shadow"
          data-testid="agent-run-count"
        >
          {{ runCount > 99 ? "99+" : runCount }}
        </Badge>
      </span>

      <!-- 挂在按钮正下方、右缘对齐：同一排左边的其他按钮（分享等）不会被它挤开 -->
      <section
        v-show="open"
        class="absolute right-0 top-full mt-2 flex h-[min(560px,calc(100vh-12rem))] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl"
        data-testid="agent-dialog"
        :aria-label="copy.name"
      >
        <header class="flex items-center gap-2 border-b px-3 py-2">
          <Bot class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <h2 class="flex min-w-0 items-center gap-1 text-sm font-medium leading-5" data-testid="agent-title">
              <!-- 别人的会话（只有项目画布上会出现）：「张三 · 会话标题」 -->
              <template v-if="foreignOwner && agent.showOwners.value">
                <span class="max-w-[45%] shrink-0 truncate" data-role="title-owner">{{ foreignOwner.name }}</span>
                <span class="shrink-0 text-muted-foreground">·</span>
              </template>
              <FlowAgentTitle v-if="agent.title.value" :text="agent.title.value" class="min-w-0 flex-1" />
              <template v-else>{{ enabled ? "新会话" : copy.name }}</template>
            </h2>
          </div>
          <template v-if="enabled">
            <Tooltip v-if="runCount > 0">
              <TooltipTrigger as-child>
                <Button
                  :variant="view === 'tasks' ? 'secondary' : 'ghost'"
                  size="xs"
                  :aria-label="`进行中的任务（${runCount}）`"
                  data-testid="agent-tasks-toggle"
                  @click="toggleView('tasks')"
                >
                  <ListChecks />
                  {{ runCount }}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ `进行中的任务（${runCount}）` }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  :variant="view === 'history' ? 'secondary' : 'ghost'"
                  size="icon-xs"
                  aria-label="历史会话"
                  data-testid="agent-history-toggle"
                  @click="toggleView('history')"
                >
                  <History />
                </Button>
              </TooltipTrigger>
              <TooltipContent>历史会话</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="新会话"
                  data-testid="agent-new"
                  @click="startNew()"
                >
                  <SquarePen />
                </Button>
              </TooltipTrigger>
              <TooltipContent>新会话</TooltipContent>
            </Tooltip>
          </template>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-xs" aria-label="收起" @click="toggle()">
                <ChevronUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent>收起</TooltipContent>
          </Tooltip>
        </header>

        <div
          v-if="agent.loading.value && !agent.session.value"
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

        <Empty v-else-if="!enabled" class="gap-2 p-6 md:p-6" data-testid="agent-disabled">
          <EmptyHeader class="gap-2">
            <EmptyMedia class="mb-0 text-muted-foreground">
              <Bot class="size-8" />
            </EmptyMedia>
            <EmptyTitle class="text-sm">服务端未配置模型</EmptyTitle>
            <EmptyDescription class="text-xs">
              {{ copy.name }}暂时用不了。管理员在服务端配置好模型之后，刷新页面即可使用。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>

        <FlowAgentHistory
          v-else-if="view === 'history'"
          :flow-id="flowId"
          :current-id="agent.conversationId.value"
          :current-running="agent.running.value"
          :show-owners="agent.showOwners.value"
          @back="backToChat()"
          @select="openConversation($event)"
          @deleted="onDeleted($event)"
        />

        <FlowAgentTasks
          v-else-if="view === 'tasks'"
          :runs="agent.activeRuns.value"
          :show-owners="agent.showOwners.value"
          :current-id="agent.conversationId.value"
          @back="backToChat()"
          @select="openConversation($event.conversationId)"
        />

        <template v-else>
          <MessageScroller class="flex-1">
            <MessageScrollerViewport aria-label="对话消息" data-testid="agent-messages">
              <MessageScrollerContent class="gap-3 px-3 py-3">
                <Empty
                  v-if="messages.length === 0"
                  class="m-auto max-w-64 flex-none gap-2 p-0 md:p-0"
                  data-testid="agent-empty"
                >
                  <EmptyHeader>
                    <EmptyMedia class="mb-0 text-muted-foreground">
                      <Sparkles class="size-6" />
                    </EmptyMedia>
                    <EmptyTitle class="text-sm">{{ copy.emptyTitle }}</EmptyTitle>
                    <EmptyDescription v-if="copy.emptyDescription" class="text-xs">
                      {{ copy.emptyDescription }}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent v-if="!copy.emptyDescription">
                    <ul class="space-y-1 text-xs text-muted-foreground">
                      <li>新建、删除节点和连线</li>
                      <li>改写节点里的文字内容</li>
                      <li>输入 <Kbd>@</Kbd> 提及节点，指定要改哪一个</li>
                    </ul>
                  </EmptyContent>
                </Empty>

                <MessageScrollerItem v-for="(message, index) in messages" :key="message.id" :message-id="message.id">
                  <FlowAgentMessage
                    :message="message"
                    :streaming="agent.running.value && index === messages.length - 1"
                  />
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
              :placeholder="copy.placeholder"
              :ignore-selection="copy.ignoreSelection"
              :attachments="attachments"
              @send="send()"
              @stop="stop()"
            />
            <!-- 别人的会话：只能看。在跑的话管理员可以停它（服务端同样只放行发起人和管理员） -->
            <div v-else class="flex items-center gap-2 text-xs text-muted-foreground" data-testid="agent-readonly">
              <Eye class="size-3.5 shrink-0" />
              <span class="min-w-0 flex-1" data-role="hint">这是 {{ agent.owner.value?.name ?? "别人" }} 的会话，只能查看</span>
              <Button
                v-if="agent.canStop.value"
                variant="outline"
                size="xs"
                :loading="agent.aborting.value"
                data-testid="agent-stop"
                @click="stop()"
              >
                <Square class="size-3 fill-current" />
                停止
              </Button>
              <Button size="xs" data-testid="agent-readonly-new" @click="startNew()">
                <SquarePen />
                发起新会话
              </Button>
            </div>
          </div>
        </template>
      </section>
  </div>
</template>
