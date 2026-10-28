<script setup lang="ts">
import { onMounted, ref } from "vue"
import { ArrowLeft, LoaderCircle, MessageSquareText, Trash2 } from "@lucide/vue"
import type { AgentConversationSummary } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
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
import FlowAgentTitle from "./FlowAgentTitle.vue"

/**
 * 历史会话列表 —— 和对话视图在同一个面板里二选一。
 *
 * 由父级用 `v-if` 挂载，所以**每次打开都重新 GET 一次**，不维护本地缓存。
 * 选中某一行只 emit `select`，加载那个会话是父级（useFlowAgent）的事。
 */
const props = defineProps<{
  flowId: string
  /** 当前对话视图里的会话 id；新会话为 null */
  currentId: string | null
  /** 这个窗口有一轮在跑：不能切到别的会话（流式事件只折叠进发起它的那个） */
  locked: boolean
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

/** 当前会话正在跑的那一轮在本窗口，列表里的 `running` 快照可能还没更新 */
function deleteDisabled(item: AgentConversationSummary) {
  return item.running || (props.locked && item.id === props.currentId)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="agent-history">
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      <Button
        variant="ghost"
        size="xs"
        aria-label="返回对话"
        title="返回对话"
        data-testid="agent-history-back"
        @click="emit('back')"
      >
        <ArrowLeft />
        返回
      </Button>
      <span class="text-xs text-muted-foreground">历史会话</span>
    </div>

    <p
      v-if="props.locked"
      class="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="agent-history-locked"
    >
      这一轮结束后再切换到别的会话
    </p>

    <div
      v-if="loading"
      class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      data-testid="agent-history-loading"
    >
      <LoaderCircle class="mr-2 size-4 animate-spin" />
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

    <div
      v-else-if="items.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
      data-testid="agent-history-empty"
    >
      <MessageSquareText class="size-6" />
      <p>还没有历史会话</p>
    </div>

    <ul v-else class="flex-1 divide-y overflow-y-auto" data-testid="agent-history-list">
      <li
        v-for="item in items"
        :key="item.id"
        :class="
          cn(
            'group relative flex items-start gap-1 px-3 py-2',
            item.id === props.currentId ? 'bg-primary/10' : 'hover:bg-muted/50'
          )
        "
        :data-conversation-id="item.id"
        :data-current="item.id === props.currentId ? 'true' : undefined"
      >
        <button
          type="button"
          class="min-w-0 flex-1 space-y-0.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="props.locked && item.id !== props.currentId"
          :title="props.locked && item.id !== props.currentId ? '这一轮结束后再切换' : undefined"
          data-role="select"
          @click="emit('select', item.id)"
        >
          <FlowAgentTitle :text="item.title" class="text-sm font-medium" data-role="title" />
          <span
            v-if="item.summary"
            class="line-clamp-2 break-words text-xs text-muted-foreground"
            data-role="summary"
          >
            {{ item.summary }}
          </span>
          <span class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span data-role="time">{{ formatDateTime(item.updatedAt) }}</span>
            <span data-role="count">{{ item.messageCount }} 条消息</span>
            <span
              v-if="item.running"
              class="inline-flex items-center gap-1 text-primary"
              data-role="running"
            >
              <LoaderCircle class="size-3 animate-spin" />
              运行中
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          :aria-label="`删除会话`"
          :title="deleteDisabled(item) ? '运行中的会话不能删除' : '删除会话'"
          :disabled="deleteDisabled(item)"
          :loading="isDeleting(item.id)"
          data-role="delete"
          @click="askDelete(item)"
        >
          <Trash2 />
        </Button>
      </li>
    </ul>

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
