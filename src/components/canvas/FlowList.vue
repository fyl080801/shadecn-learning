<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { refDebounced } from "@vueuse/core"
import { MoreHorizontal, Plus, Search } from "lucide-vue-next"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"

import { flowApi } from "@/lib/api"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { formatDateTime } from "@/lib/format"
import type { FlowSummary } from "@/types/flow"

/**
 * 一个容器里的画布列表：搜索 / 排序 / 分页 + 新建、重命名、复制、删除。
 *
 * 两处在用，而且**必须是同一个组件**：项目主页的「画布」Tab，和项目列表页的
 * 「个人画布」Tab（REQ-SOLO §4.8）。个人空间在接口层面就是个项目，所以这里
 * 一个 `projectId` 就够了 —— 组件不需要知道自己列的是哪一种。
 *
 * **不碰路由是默认行为**（`syncQuery`）。项目主页只有这一个列表，页码和关键字
 * 写进 URL 是对的；而项目列表页有两个并列的 Tab，两边共用一份 query 只会互相串 ——
 * 「项目搜到第 3 页」的 query 跟到个人画布那边，就落在一个空页上。
 */

const props = defineProps<{
  projectId: string
  /** 把页码 / 关键字 / 排序写进 URL。同一页面只该有一个列表这么做 */
  syncQuery?: boolean
  /** 一张画布都没有时的提示语 */
  emptyHint?: string
}>()

/** 列表总数交给父组件（Tab 标题上要显示） */
const total = defineModel<number>("total", { default: 0 })

/** 删除 / 复制 / 新建之后通知父组件刷新它自己的统计 */
const emit = defineEmits<{ changed: [] }>()

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 20

const flows = ref<FlowSummary[]>([])
const totalPages = ref(1)
const loading = ref(true)

const localPage = ref(1)
const page = computed(() =>
  props.syncQuery ? Number(route.query.page ?? 1) || 1 : localPage.value
)

const keyword = ref(props.syncQuery ? String(route.query.keyword ?? "") : "")
const debouncedKeyword = refDebounced(keyword, 300)
const sort = ref(props.syncQuery ? String(route.query.sort ?? "updatedAt:desc") : "updatedAt:desc")

async function load() {
  loading.value = true
  try {
    const data = await flowApi.list(props.projectId, {
      page: page.value,
      pageSize: PAGE_SIZE,
      keyword: debouncedKeyword.value.trim() || undefined,
      sort: sort.value
    })
    flows.value = data.items
    total.value = data.total
    totalPages.value = Math.max(1, data.totalPages)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "画布列表加载失败")
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.projectId, page.value, debouncedKeyword.value, sort.value] as const,
  () => void load(),
  { immediate: true }
)

// 换关键字要回到第一页，否则会停在一个空页上
watch(debouncedKeyword, (word) => {
  if (!props.syncQuery) {
    localPage.value = 1
    return
  }
  if (word === String(route.query.keyword ?? "")) return
  void router.replace({ query: { ...route.query, keyword: word || undefined, page: undefined } })
})

watch(sort, (value) => {
  if (!props.syncQuery) {
    localPage.value = 1
    return
  }
  void router.replace({
    query: { ...route.query, sort: value === "updatedAt:desc" ? undefined : value, page: undefined }
  })
})

function goPage(next: number) {
  if (next < 1 || next > totalPages.value) return
  if (!props.syncQuery) {
    localPage.value = next
    return
  }
  void router.push({ query: { ...route.query, page: next === 1 ? undefined : next } })
}

// —— 增删改 ——

const creating = ref(false)
const draft = ref("")

function startCreate() {
  draft.value = ""
  creating.value = true
}

const { run: submitCreate, pending: creatingPending } = useAsyncAction(async () => {
  const name = draft.value.trim()
  if (!name) {
    toast.error("请填写画布名称")
    return
  }
  const flow = await flowApi.create(props.projectId, { name })
  creating.value = false
  emit("changed")
  void router.push(`/flows/${flow.id}`)
}, { errorMessage: "创建失败" })

const renaming = ref<FlowSummary | null>(null)
const nameDraft = ref("")

function startRename(flow: FlowSummary) {
  renaming.value = flow
  nameDraft.value = flow.name
}

const { run: submitRename, pending: renamingPending } = useAsyncAction(async () => {
  const target = renaming.value
  const name = nameDraft.value.trim()
  renaming.value = null
  if (!target || !name || name === target.name) return

  await flowApi.update(target.id, { name })
  await load()
}, { errorMessage: "改名失败" })

// 每行各记各的：复制 A 行不该把 B 行的菜单也锁上
const { run: duplicate } = useAsyncAction(
  async (flow: FlowSummary) => {
    const copy = await flowApi.duplicate(flow.id)
    toast.success(`已复制为「${copy.name}」`)
    emit("changed")
    await load()
  },
  { errorMessage: "复制失败", key: (flow) => flow.id }
)

/**
 * 二次确认对话框：开关和「操作哪一个」要分开两个 ref。
 * AlertDialogAction 是先关对话框、再跑透传下来的 @click，
 * 合成一个 ref 的话 handler 里读到的永远是关闭时清掉的 null，请求就发不出去。
 */
const deleting = ref<FlowSummary | null>(null)
const deleteOpen = ref(false)

function startDelete(flow: FlowSummary) {
  deleting.value = flow
  deleteOpen.value = true
}

const { run: confirmDelete } = useAsyncAction(async () => {
  const target = deleting.value
  if (!target) return

  await flowApi.remove(target.id)
  emit("changed")
  await load()
}, { errorMessage: "删除失败" })

defineExpose({ reload: load })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <div class="flex items-center gap-2">
      <div class="relative max-w-sm flex-1">
        <Search
          class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input v-model="keyword" placeholder="搜索画布名称" class="pl-9" />
      </div>

      <Select v-model="sort">
        <SelectTrigger class="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updatedAt:desc">最近更新</SelectItem>
          <SelectItem value="createdAt:desc">最近创建</SelectItem>
          <SelectItem value="name:asc">名称</SelectItem>
        </SelectContent>
      </Select>

      <Button class="ml-auto" @click="startCreate">
        <Plus />
        新建画布
      </Button>
    </div>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <div
      v-else-if="flows.length === 0"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <p class="text-sm text-muted-foreground">
        {{ keyword ? "没有匹配的画布" : (emptyHint ?? "这个项目还没有画布") }}
      </p>
      <Button v-if="!keyword" variant="outline" size="sm" @click="startCreate">新建画布</Button>
    </div>

    <template v-else>
      <div class="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead class="w-20 text-right">节点</TableHead>
              <TableHead class="w-20 text-right">连线</TableHead>
              <TableHead class="w-44">更新时间</TableHead>
              <TableHead class="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="flow in flows"
              :key="flow.id"
              class="cursor-pointer"
              @click="router.push(`/flows/${flow.id}`)"
            >
              <TableCell>
                <div class="font-medium">{{ flow.name }}</div>
                <div v-if="flow.description" class="line-clamp-1 text-xs text-muted-foreground">
                  {{ flow.description }}
                </div>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ flow.nodeCount }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ flow.edgeCount }}</TableCell>
              <TableCell class="text-sm text-muted-foreground">
                {{ formatDateTime(flow.updatedAt) }}
              </TableCell>
              <TableCell @click.stop>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem @select="startRename(flow)">重命名</DropdownMenuItem>
                    <DropdownMenuItem @select="duplicate(flow)">复制</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" @select="startDelete(flow)">
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {{ total }} 张画布</span>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" :disabled="page <= 1" @click="goPage(page - 1)">
            上一页
          </Button>
          <span class="tabular-nums">{{ page }} / {{ totalPages }}</span>
          <Button
            variant="outline"
            size="sm"
            :disabled="page >= totalPages"
            @click="goPage(page + 1)"
          >
            下一页
          </Button>
        </div>
      </div>
    </template>

    <!-- 新建画布 -->
    <Dialog v-model:open="creating">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建画布</DialogTitle>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="flow-name">名称</Label>
          <Input
            id="flow-name"
            v-model="draft"
            placeholder="例如：下单主流程"
            maxlength="80"
            @keydown.enter="submitCreate()"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creatingPending" @click="creating = false">
            取消
          </Button>
          <Button :loading="creatingPending" @click="submitCreate()">创建并打开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 重命名画布 -->
    <Dialog :open="renaming !== null" @update:open="(v) => !v && (renaming = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名画布</DialogTitle>
        </DialogHeader>
        <Input v-model="nameDraft" maxlength="80" @keydown.enter="submitRename()" />
        <DialogFooter>
          <Button variant="outline" :disabled="renamingPending" @click="renaming = null">
            取消
          </Button>
          <Button :loading="renamingPending" @click="submitRename()">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除画布「{{ deleting?.name }}」？</AlertDialogTitle>
          <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmDelete()">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
