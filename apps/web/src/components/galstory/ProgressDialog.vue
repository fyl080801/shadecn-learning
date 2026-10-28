<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { Trash2 } from "@lucide/vue"
import { toast } from "vue-sonner"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

import { useAsyncAction } from "@/composables/useAsyncAction"
import { formatDateTime } from "@/lib/format"
import { saveApi } from "@/lib/galstory"
import type { SaveSummary, StorySummary } from "@/types/galstory"

/**
 * 「读进度」——列出**当前登录用户**在这个故事下玩过的实例。
 *
 * ⚠️ **这里没有任何按用户过滤的代码，那是对的**：关联发生在服务端那一层，每条转发都带着
 * `X-Gal-Owner: <登录用户 id>`，引擎按属主分存档目录，`GET /saves` 天然就只返回自己的。
 * 在前端再滤一次等于让同一个判据有两处声明，而**前端那一处还挡不住任何人** —— 真正的隔离
 * 必须在拿到数据之前发生。
 */

const props = defineProps<{ story: StorySummary | null }>()
const emit = defineEmits<{ close: []; play: [saveId: string] }>()

const items = ref<SaveSummary[]>([])
const loading = ref(false)
const error = ref<unknown>(null)

/**
 * 二次确认：**「开关」与「删哪一份」必须是两个 ref**。
 *
 * ⚠️ reka-ui 的 `AlertDialogAction` 内部就是 `DialogClose` —— **先关掉对话框、再**跑透传下来的
 * `@click`，而它那句关闭是裸的 `onOpenChange(false)`、**不看 `event.defaultPrevented`**，故
 * `@click.prevent` 挡不住（试过，没用）。合成一个 ref 的话，关闭动作会先把它清成 null，
 * handler 里读到的就是 null → 请求一声不响地发不出去，界面上看起来就是「点了删除，框关了，
 * 进度还在」。同一个坑在 `FlowList.vue` / `LinkedAccounts.vue` 里各钉过一次。
 */
const pendingDelete = ref<SaveSummary | null>(null)
const deleteOpen = ref(false)

function askDelete(save: SaveSummary) {
  pendingDelete.value = save
  deleteOpen.value = true
}

const open = computed(() => props.story !== null)

watch(
  () => props.story,
  async (story) => {
    if (!story) return
    loading.value = true
    error.value = null
    try {
      items.value = await saveApi.list(story.name)
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

const { run: confirmDelete, pending: deleting } = useAsyncAction(async () => {
  const target = pendingDelete.value
  if (!target) return
  await saveApi.remove(target.id)
  items.value = items.value.filter((s) => s.id !== target.id)
  // 对话框已经被 AlertDialogAction 自己关掉了，这里不再动 `deleteOpen`；
  // `pendingDelete` 也留着 —— 关闭有动画，清掉会让框里的文案在收起途中变成空白。
  toast.success("进度已删除")
}, { errorMessage: "删除失败" })
</script>

<template>
  <Dialog :open="open" @update:open="(next) => !next && emit('close')">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ story?.title }} —— 我的进度</DialogTitle>
        <DialogDescription>
          每一份进度都是一个独立的存档：里面冻结了当时那份故事模板的整副本，此后作者改模板
          也不影响它。
        </DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="flex flex-col gap-2">
        <Skeleton v-for="i in 3" :key="i" class="h-16 w-full" />
      </div>

      <p v-else-if="error" class="py-6 text-center text-sm text-destructive">
        {{ error instanceof Error ? error.message : "读不到进度" }}
      </p>

      <div
        v-else-if="items.length === 0"
        class="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center"
      >
        <p class="text-sm text-muted-foreground">还没有玩过这个故事</p>
        <p class="text-xs text-muted-foreground">从故事列表上「新开始」开一局</p>
      </div>

      <ul v-else class="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
        <li
          v-for="save in items"
          :key="save.id"
          class="flex items-center gap-3 rounded-lg border p-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">
                <!-- 存档可以没有标题（建的时候没填），那就退回它的 id，别显示一个空行 -->
                {{ save.title || save.id }}
              </span>
              <!-- 「建了存档」≠「开过跑」：没开过跑的那份里一轮实录都没有 -->
              <Badge v-if="!save.progress.started" variant="outline">未开始</Badge>
              <Badge v-else-if="save.open" variant="secondary">进行中</Badge>
            </div>
            <p class="truncate text-xs text-muted-foreground">
              {{ save.progress.label || "尚未开跑" }} · {{ formatDateTime(save.created) }}
            </p>
          </div>
          <Button size="sm" @click="emit('play', save.id)">继续</Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="删除这份进度"
            @click="askDelete(save)"
          >
            <Trash2 class="size-4 text-destructive" />
          </Button>
        </li>
      </ul>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 删存档是**不可逆**的：几十轮实录、知识库、关系日志一起没。必须问一句 -->
  <AlertDialog :open="deleteOpen" @update:open="(next) => !next && (deleteOpen = false)">
    <AlertDialogContent v-if="pendingDelete">
      <AlertDialogHeader>
        <AlertDialogTitle>删除这份进度？</AlertDialogTitle>
        <AlertDialogDescription>
          「{{ pendingDelete.title || pendingDelete.id }}」（{{
            pendingDelete.progress.label || "尚未开跑"
          }}）会被整个删掉，连同这一局的全部实录、知识库与角色对你的印象。**删了回不来。**
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="deleting">取消</AlertDialogCancel>
        <AlertDialogAction :disabled="deleting" @click="confirmDelete()">
          删除
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
