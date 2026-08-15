<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { refDebounced } from "@vueuse/core"
import { FolderPlus, Search, Users } from "lucide-vue-next"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"

import { projectApi } from "@/lib/api"
import type { ProjectSummary } from "@/types/flow"
import { formatDateTime } from "@/lib/format"

/**
 * 项目列表 —— 应用里画布的入口。
 * 只列出我是成员的项目：没有「所有项目」视图，也没有公开项目。
 */

const route = useRoute()
const router = useRouter()

const items = ref<ProjectSummary[]>([])
const total = ref(0)
const totalPages = ref(1)
const loading = ref(true)
const error = ref<string | null>(null)

// 页码与关键字都写进 URL，刷新/分享后状态不变
const page = computed(() => Number(route.query.page ?? 1) || 1)
const keyword = ref(String(route.query.keyword ?? ""))
const debouncedKeyword = refDebounced(keyword, 300)

const PAGE_SIZE = 20

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await projectApi.list({
      page: page.value,
      pageSize: PAGE_SIZE,
      keyword: debouncedKeyword.value.trim() || undefined
    })
    items.value = data.items
    total.value = data.total
    totalPages.value = Math.max(1, data.totalPages)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(
  () => [page.value, debouncedKeyword.value] as const,
  ([, word], old) => {
    // 换关键字要回到第一页，否则会停在一个空页上
    if (old && word !== old[1] && page.value !== 1) {
      void router.replace({ query: { ...route.query, keyword: word || undefined, page: undefined } })
      return
    }
    void load()
  },
  { immediate: true }
)

watch(debouncedKeyword, (word) => {
  const current = String(route.query.keyword ?? "")
  if (word === current) return
  void router.replace({ query: { ...route.query, keyword: word || undefined, page: undefined } })
})

function goPage(next: number) {
  if (next < 1 || next > totalPages.value) return
  void router.push({ query: { ...route.query, page: next === 1 ? undefined : next } })
}

// —— 新建 ——

const creating = ref(false)
const draft = ref({ name: "", description: "" })
const submitting = ref(false)

function openCreate() {
  draft.value = { name: "", description: "" }
  creating.value = true
}

async function submitCreate() {
  const name = draft.value.name.trim()
  if (!name) {
    toast.error("请填写项目名称")
    return
  }

  submitting.value = true
  try {
    const project = await projectApi.create({
      name,
      description: draft.value.description.trim() || null
    })
    creating.value = false
    toast.success(`项目「${project.name}」已创建`)
    void router.push(`/projects/${project.id}`)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "创建失败")
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
    <header class="flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">项目</h1>
        <p class="text-sm text-muted-foreground">画布按项目归类，项目成员共享其中的全部画布。</p>
      </div>
      <Button @click="openCreate">
        <FolderPlus />
        新建项目
      </Button>
    </header>

    <div class="relative max-w-sm">
      <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="keyword" placeholder="搜索项目名称" class="pl-9" />
    </div>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-14 w-full" />
    </div>

    <div
      v-else-if="error"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <p class="text-sm text-destructive">{{ error }}</p>
      <Button variant="outline" size="sm" @click="load">重试</Button>
    </div>

    <div
      v-else-if="items.length === 0"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <Users class="size-8 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">
        {{ keyword ? "没有匹配的项目" : "你还没有项目 —— 新建一个，或者让同事把邀请链接发给你" }}
      </p>
      <Button v-if="!keyword" variant="outline" size="sm" @click="openCreate">新建项目</Button>
    </div>

    <template v-else>
      <div class="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead class="w-24">我的角色</TableHead>
              <TableHead class="w-20 text-right">成员</TableHead>
              <TableHead class="w-20 text-right">画布</TableHead>
              <TableHead class="w-44">更新时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="project in items"
              :key="project.id"
              class="cursor-pointer"
              @click="router.push(`/projects/${project.id}`)"
            >
              <TableCell>
                <div class="font-medium">{{ project.name }}</div>
                <div v-if="project.description" class="line-clamp-1 text-xs text-muted-foreground">
                  {{ project.description }}
                </div>
              </TableCell>
              <TableCell>
                <Badge :variant="project.myRole === 'admin' ? 'default' : 'secondary'">
                  {{ project.myRole === "admin" ? "管理员" : "成员" }}
                </Badge>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ project.memberCount }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ project.flowCount }}</TableCell>
              <TableCell class="text-sm text-muted-foreground">
                {{ formatDateTime(project.updatedAt) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {{ total }} 个项目</span>
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

    <Dialog v-model:open="creating">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>你会成为这个项目的管理员，可以邀请其他人加入。</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="project-name">名称</Label>
            <Input
              id="project-name"
              v-model="draft.name"
              placeholder="例如：订单系统"
              maxlength="80"
              @keydown.enter="submitCreate"
            />
          </div>
          <div class="space-y-2">
            <Label for="project-desc">描述（可选）</Label>
            <Textarea id="project-desc" v-model="draft.description" rows="3" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="creating = false">取消</Button>
          <Button :disabled="submitting" @click="submitCreate">创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
