<script setup lang="ts">
import { onMounted, ref } from "vue"
import { ArrowLeft, MessageSquareText, Trash2 } from "@lucide/vue"
import type { AgentConversationSummary } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { toast } from "vue-sonner"
import { ApiError, agentApi } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAsyncAction } from "@/composables/useAsyncAction"
import FlowAgentOwner from "./FlowAgentOwner.vue"
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 历史会话列表 —— 和对话视图在同一个面板里切换。
 *
 * 由父级用 `v-if` 挂载，所以**每次打开都重新 GET 一次**，不维护本地缓存。
 * 选中某一行只 emit `select`，加载那个会话是父级（useFlowAgent）的事；当前会话在跑也能切走
 * （只断本地的读，那一轮照跑）。
 *
 * 项目画布上列的是这张画布上**所有人**的会话：每行带发起人和「我的」；别人的只读，没有删除按钮
 * （服务端也会 403，docs/20 §3.9）。个人画布上只有自己的，不显示用户标识。
 */
const props = defineProps<{
  flowId: string
  /** 当前对话视图里的会话 id；新会话为 null */
  currentId: string | null
  /** 当前会话正在跑（列表里的 `running` 快照可能还没更新）：它不能删 */
  currentRunning: boolean
  /** 项目画布：每行显示发起人 */
  showOwners: boolean
}>()

const emit = defineEmits<{
  back: []
  select: [id: string]
  /** 某个会话删掉了 */
  deleted: [id: string]
}>()

const items = ref<AgentConversationSummary[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

/** 请求序号：重试时丢掉先发出去的那次的响应 */
let seq = 0

async function load() {
  const mine = ++seq
  loading.value = true
  error.value = null
  try {
    const list = await agentApi.conversations(props.flowId)
    if (mine === seq) items.value = list
  } catch (e) {
    if (mine === seq) error.value = e instanceof Error ? e.message : "加载历史会话失败"
  } finally {
    if (mine === seq) loading.value = false
  }
}

onMounted(() => void load())

// —— 删除：两个 ref —— AlertDialogAction 会先关对话框再跑 @click，
// 只用一个 ref 的话处理函数读到的目标已经被清空了
const confirming = ref(false)
const target = ref<AgentConversationSummary | null>(null)

function askDelete(item: AgentConversationSummary) {
  target.value = item
  confirming.value = true
}

const { run: remove, isPending: isDeleting } = useAsyncAction(
  async (item: AgentConversationSummary) => {
    await agentApi.deleteConversation(props.flowId, item.id)
    items.value = items.value.filter((row) => row.id !== item.id)
    emit("deleted", item.id)
  },
  {
    key: (item) => item.id,
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast.error("这个会话正在运行，等它结束再删除")
        void load()
      } else if (e instanceof ApiError && e.status === 403) {
        toast.error("这是别人的会话，只有发起人能删除")
      } else if (e instanceof ApiError && e.status === 404) {
        toast.error("这个会话已经不存在了")
        void load()
      } else {
        toast.error(e instanceof Error ? e.message : "删除失败")
      }
    }
  }
)

function confirmDelete() {
  if (target.value) void remove(target.value)
}

function deleteDisabled(item: AgentConversationSummary) {
  return item.running || (props.currentRunning && item.id === props.currentId)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="agent-history">
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="xs"
            aria-label="返回对话"
            data-testid="agent-history-back"
            @click="emit('back')"
          >
            <ArrowLeft />
            返回
          </Button>
        </TooltipTrigger>
        <TooltipContent>返回对话</TooltipContent>
      </Tooltip>
      <span class="text-xs text-muted-foreground">历史会话</span>
    </div>

    <div
      v-if="loading"
      class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      data-testid="agent-history-loading"
    >
      <Spinner class="mr-2" />
      正在加载…
    </div>

    <div
      v-else-if="error"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
      data-testid="agent-history-error"
    >
      <p class="text-destructive">{{ error }}</p>
      <Button variant="outline" size="sm" @click="load()">重试</Button>
    </div>

    <Empty v-else-if="items.length === 0" class="gap-2 p-6 md:p-6" data-testid="agent-history-empty">
      <EmptyHeader>
        <EmptyMedia class="mb-0 text-muted-foreground">
          <MessageSquareText class="size-6" />
        </EmptyMedia>
        <EmptyTitle class="text-sm font-normal text-muted-foreground">还没有历史会话</EmptyTitle>
      </EmptyHeader>
    </Empty>

    <!--
      标准的 Item 列表：ItemGroup（role=list）→ Item（role=listitem）→ ItemContent / ItemActions，行间 ItemSeparator。
      整行可点用「拉伸按钮」：标题里的 button 靠 after:absolute after:inset-0 盖满整行（button 里放不下
      ItemContent 这些 div，所以不把整行做成 button）；删除按钮在 ItemActions 里、z-10 压在它上面，点得到。
    -->
    <ItemGroup v-else class="flex-1 overflow-y-auto" data-testid="agent-history-list">
      <template v-for="(item, index) in items" :key="item.id">
        <ItemSeparator v-if="index > 0" />
        <Item
          role="listitem"
          size="sm"
          :class="
            cn(
              'group relative flex-nowrap items-start rounded-none border-0 px-3 py-2',
              item.id === props.currentId ? 'bg-primary/10' : 'hover:bg-muted/50'
            )
          "
          :data-conversation-id="item.id"
          :data-current="item.id === props.currentId ? 'true' : undefined"
        >
          <ItemContent class="min-w-0 gap-0.5">
            <ItemTitle class="w-full">
              <button
                type="button"
                class="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
                data-role="select"
                @click="emit('select', item.id)"
              >
                <FlowAgentTitle :text="item.title" data-role="title" />
              </button>
            </ItemTitle>
            <ItemDescription v-if="item.summary" class="break-words text-xs" data-role="summary">
              {{ item.summary }}
            </ItemDescription>
            <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
              <FlowAgentOwner v-if="props.showOwners" :owner="item.owner" :mine="item.mine" class="max-w-32" />
              <span data-role="time">{{ formatDateTime(item.updatedAt) }}</span>
              <span data-role="count">{{ item.messageCount }} 条消息</span>
              <span v-if="item.running" class="inline-flex items-center gap-1 text-primary" data-role="running">
                <Spinner class="size-3" />
                运行中
              </span>
            </div>
          </ItemContent>
          <ItemActions v-if="item.mine" class="relative z-10">
            <Tooltip>
              <TooltipTrigger as-child>
                <!-- 禁用的按钮收不到鼠标事件，提示挂在外面这层 span 上，才能解释「为什么删不了」 -->
                <span class="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label="删除会话"
                    :disabled="deleteDisabled(item)"
                    :loading="isDeleting(item.id)"
                    data-role="delete"
                    @click="askDelete(item)"
                  >
                    <Trash2 />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{{ deleteDisabled(item) ? "运行中的会话不能删除" : "删除会话" }}</TooltipContent>
            </Tooltip>
          </ItemActions>
        </Item>
      </template>
    </ItemGroup>

    <AlertDialog v-model:open="confirming">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个会话？</AlertDialogTitle>
          <AlertDialogDescription>
            只删除你和 agent 的这段聊天记录，画布上的内容不受影响。删除之后无法恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmDelete()">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
