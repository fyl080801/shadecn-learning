<script setup lang="ts">
import { ArrowLeft, ChevronRight, ListChecks } from "@lucide/vue"
import { useNow } from "@vueuse/core"
import type { AgentActiveRunView } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import FlowAgentOwner from "./FlowAgentOwner.vue"
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 「进行中的任务」—— 和对话 / 历史在同一个面板里三选一（docs/20 §3.10.4）。
 *
 * 数据是 `useFlowAgent().activeRuns`（推送实时更新），这里只展示；点一行只 emit `select`，
 * 打开那个会话（别人的只读 + 旁观实时进度）是父级的事。已运行时长每秒走一次，
 * 只在这个列表挂着时走（父级 `v-if`）。开始时刻是服务端打的，和本机时钟差出来的负数按 0 算。
 */
const props = defineProps<{
  runs: AgentActiveRunView[]
  /** 项目画布：每行带发起人；个人画布不显示用户标识 */
  showOwners: boolean
  currentId: string | null
}>()

const emit = defineEmits<{
  back: []
  select: [run: AgentActiveRunView]
}>()

const now = useNow({ interval: 1000 })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="agent-tasks">
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="xs"
            aria-label="返回对话"
            data-testid="agent-tasks-back"
            @click="emit('back')"
          >
            <ArrowLeft />
            返回
          </Button>
        </TooltipTrigger>
        <TooltipContent>返回对话</TooltipContent>
      </Tooltip>
      <span class="text-xs text-muted-foreground">进行中的任务</span>
    </div>

    <Empty v-if="props.runs.length === 0" class="gap-2 p-6 md:p-6" data-testid="agent-tasks-empty">
      <EmptyHeader>
        <EmptyMedia class="mb-0 text-muted-foreground">
          <ListChecks class="size-6" />
        </EmptyMedia>
        <EmptyTitle class="text-sm font-normal text-muted-foreground">没有进行中的任务</EmptyTitle>
      </EmptyHeader>
    </Empty>

    <!--
      标准的 Item 列表：ItemGroup（role=list）里每行一个 Item（role=listitem），行与行之间是 ItemSeparator。
      整行可点用「拉伸按钮」：标题里的 button 靠 after:absolute after:inset-0 盖满整行 ——
      不把 Item 本身做成 button，因为 button 里只能放行内内容，放不下 ItemContent 这些 div。
    -->
    <ItemGroup v-else class="flex-1 overflow-y-auto" data-testid="agent-tasks-list">
      <template v-for="(run, index) in props.runs" :key="run.runId">
        <ItemSeparator v-if="index > 0" />
        <Item
          role="listitem"
          size="sm"
          :class="
            cn(
              'relative flex-nowrap rounded-none border-0 px-3 py-2',
              run.conversationId === props.currentId ? 'bg-primary/10' : 'hover:bg-muted/50'
            )
          "
          :data-run-id="run.runId"
        >
          <ItemMedia>
            <Spinner class="text-primary motion-reduce:animate-none" />
          </ItemMedia>
          <ItemContent class="min-w-0 gap-0.5">
            <ItemTitle class="w-full">
              <button
                type="button"
                class="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
                data-role="select"
                @click="emit('select', run)"
              >
                <FlowAgentTitle :text="run.conversationTitle" data-role="title" />
              </button>
            </ItemTitle>
            <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
              <FlowAgentOwner v-if="props.showOwners" :owner="run.owner" :mine="run.mine" />
              <span class="shrink-0" data-role="elapsed">已运行 {{ formatDuration(now.getTime() - run.startedAt) }}</span>
            </div>
          </ItemContent>
          <ItemActions>
            <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
      </template>
    </ItemGroup>
  </div>
</template>
