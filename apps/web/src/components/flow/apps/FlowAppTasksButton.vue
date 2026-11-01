<script setup lang="ts">
import { computed } from "vue"
import { ListChecks, X } from "@lucide/vue"
import { useNow } from "@vueuse/core"
import type { AppTaskView } from "@shadecn/shared/apps"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "@/components/ui/item"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import FlowAgentOwner from "@/components/flow/agent/FlowAgentOwner.vue"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useOptionalFlowAppTasks } from "@/composables/flow/useFlowAppTasks"
import { useAuth } from "@/lib/auth"
import { formatDuration } from "@/lib/format"

/**
 * 右上角的「生成任务」按钮（docs/29 §3.10）—— 和 agent 的对话按钮**分开**：这里只管画布上进行中的生成任务。
 *
 * - 按钮：有任务在跑时外圈转一个环、右上角挂任务数（同对话按钮的样子；减少动态效果时只留角标）；
 * - 点开是一个浮层（Popover，按钮正下方、右缘对齐）：每行 应用 · 节点名、发起人（项目画布）、状态 / 进度、已用时，
 *   宽高和对话面板一样固定（列表在里面垂直滚动），点一行定位到那个节点（浮层不关，方便接着看别的），行尾「取消」只给发起人和项目管理员；没有任务时一句空状态。
 *
 * 数据是画布那一份 `useFlowAppTasks`（推送实时更新），这里只展示。已用时每秒走一次，只在浮层开着时走。
 * 位置由 `FlowEditor.vue` 决定（右上角那排：分享、生成任务、对话）。
 */
const editor = useFlowEditor()
const appTasks = useOptionalFlowAppTasks()
const { user } = useAuth()

const tasks = computed(() => appTasks?.tasks.value ?? [])
const count = computed(() => tasks.value.length)
const label = computed(() => (count.value > 0 ? `生成任务（${count.value} 个进行中）` : "生成任务"))
/** 项目画布：每行带发起人；个人画布只有自己 */
const showOwners = computed(() => editor.store.meta?.mode === "collab")

const now = useNow({ interval: 1000 })

function nodeLabel(nodeId: string): string {
  const label = editor.store.nodeById.get(nodeId)?.metadata.label
  return typeof label === "string" ? label : ""
}

function queued(task: AppTaskView): boolean {
  return task.status === "queued" || task.progress?.status === "queued"
}

function percent(task: AppTaskView): number | null {
  const ratio = task.progress?.ratio
  return ratio === undefined || queued(task) ? null : Math.round(ratio * 100)
}

function statusText(task: AppTaskView): string {
  if (queued(task)) return "排队中"
  const value = percent(task)
  return value === null ? "生成中" : `生成中 ${value}%`
}

function reveal(task: AppTaskView) {
  void editor.canvas.revealNode(task.nodeId)
}
</script>

<template>
  <span class="relative inline-flex">
    <!-- 有任务在跑：沿按钮边缘转一个环（同对话按钮） -->
    <span
      v-if="count > 0"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-10 rounded-full border-2 border-primary/20 border-t-primary motion-safe:animate-spin motion-reduce:hidden"
      data-testid="app-tasks-ring"
    />
    <!--
      **Tooltip 在外、Popover 在它触发器的 span 里**（同 FlowViewControls 的小地图）：两者都是 popper，
      Popover 套在外面的话，它的触发器的锚点会登记到里层 Tooltip 的定位上下文上，浮层没有锚点、一直停在屏幕外面。
    -->
    <Tooltip>
      <TooltipTrigger as-child>
        <span class="inline-flex">
          <Popover>
            <PopoverTrigger as-child>
              <Button
                variant="outline"
                size="icon"
                class="relative size-10 rounded-full bg-card/95 shadow-lg backdrop-blur"
                :aria-label="label"
                data-testid="app-tasks-toggle"
              >
                <ListChecks class="size-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              :side-offset="8"
              class="nowheel nodrag nopan flex h-[min(560px,calc(100vh-12rem))] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
              data-testid="app-tasks-panel"
            >
              <header class="shrink-0 border-b px-3 py-2 text-sm font-medium">进行中的生成任务</header>

              <Empty v-if="count === 0" class="flex-1 gap-2 p-6 md:p-6" data-testid="app-tasks-empty">
                <EmptyHeader>
                  <EmptyMedia class="mb-0 text-muted-foreground">
                    <ListChecks class="size-6" />
                  </EmptyMedia>
                  <EmptyTitle class="text-sm font-normal text-muted-foreground">没有进行中的生成任务</EmptyTitle>
                </EmptyHeader>
              </Empty>

              <!-- 整行可点用「拉伸按钮」（同对话面板的任务列表）：标题里的 button 靠 after:inset-0 盖满整行 -->
              <ItemGroup v-else class="min-h-0 flex-1 overflow-y-auto" data-testid="app-tasks-list">
                <template v-for="(task, index) in tasks" :key="task.id">
                  <ItemSeparator v-if="index > 0" />
                  <Item
                    role="listitem"
                    size="sm"
                    class="relative flex-nowrap rounded-none border-0 px-3 py-2 hover:bg-muted/50"
                    :data-task-id="task.id"
                  >
                    <ItemMedia>
                      <Spinner class="text-primary motion-reduce:animate-none" />
                    </ItemMedia>
                    <ItemContent class="min-w-0 gap-1">
                      <ItemTitle class="w-full">
                        <button
                          type="button"
                          class="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
                          data-role="reveal"
                          @click="reveal(task)"
                        >
                          <span data-role="app">{{ task.appTitle }}</span>
                          <span v-if="nodeLabel(task.nodeId)" class="text-muted-foreground" data-role="node">
                            · {{ nodeLabel(task.nodeId) }}
                          </span>
                        </button>
                      </ItemTitle>
                      <Progress v-if="percent(task) !== null" :model-value="percent(task)" class="h-1" />
                      <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <FlowAgentOwner v-if="showOwners" :owner="task.owner" :mine="task.owner.id === user?.id" />
                        <span class="shrink-0 tabular-nums" data-role="status">{{ statusText(task) }}</span>
                        <span class="shrink-0 tabular-nums" data-role="elapsed">
                          已用 {{ formatDuration(Math.max(0, now.getTime() - (task.startedAt ?? task.createdAt))) }}
                        </span>
                      </div>
                    </ItemContent>
                    <ItemActions v-if="appTasks?.canCancel(task)">
                      <Button
                        variant="ghost"
                        size="xs"
                        class="relative z-10"
                        :aria-label="`取消「${task.appTitle}」`"
                        data-role="cancel"
                        :loading="appTasks.isCancelling(task.id)"
                        @click="appTasks.cancel(task)"
                      >
                        <X />
                        取消
                      </Button>
                    </ItemActions>
                  </Item>
                </template>
              </ItemGroup>
            </PopoverContent>
          </Popover>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ label }}</TooltipContent>
    </Tooltip>
    <Badge
      v-if="count > 0"
      as="span"
      aria-hidden="true"
      class="pointer-events-none absolute -right-1 -top-1 z-20 h-4 min-w-4 px-1 py-0 text-[10px] font-semibold leading-none tabular-nums shadow"
      data-testid="app-tasks-count"
    >
      {{ count > 99 ? "99+" : count }}
    </Badge>
  </span>
</template>
