<script setup lang="ts">
import { ref } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"
import { Plus, Trash2, UserRoundPen } from "@lucide/vue"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

import { projectApi } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { useProjectNav } from "@/composables/useProjectNav"
import type { ProjectSummary } from "@shadecn/shared/canvas"

/**
 * 画布工作区的壳 —— 左边一条**页内二级侧栏**，右边（默认插槽）是内容区。
 *
 * 个人画布和项目原来是两个页面、两个应用侧栏入口；现在合成一个界面：
 * 侧栏第一项是「个人画布」，下面的「项目」分组列出我是成员的项目，
 * 点谁内容区就换成谁。切换仍是路由跳转（`/canvas`、`/projects/:id`），
 * 所以刷新、书签、返回键都照常工作 —— 壳只是每个页面各包一份，列表状态放在
 * `useProjectNav` 的模块级缓存里，换页时侧栏不会闪 loading。
 *
 * 这条侧栏不是 `AppSidebar` 的一部分：应用侧栏管「去哪个功能」，这条管「在画布功能里看哪个容器」。
 */

const route = useRoute()
const router = useRouter()
const { projects, total, loading, error, refresh } = useProjectNav()

function isCurrent(project: ProjectSummary) {
  return route.path === `/projects/${project.id}`
}

// —— 新建项目 ——

const creating = ref(false)
const draft = ref({ name: "", description: "" })

function openCreate() {
  draft.value = { name: "", description: "" }
  creating.value = true
}

// 按钮和回车是同一个入口，连点 / 连按都只会建出一个项目
const { run: submitCreate, pending: submitting } = useAsyncAction(async () => {
  const name = draft.value.name.trim()
  if (!name) {
    toast.error("请填写项目名称")
    return
  }

  const project = await projectApi.create({
    name,
    description: draft.value.description.trim() || null
  })
  creating.value = false
  toast.success(`项目「${project.name}」已创建`)
  await refresh()
  void router.push(`/projects/${project.id}`)
}, { errorMessage: "创建失败" })

// —— 删除项目 ——
//
// 两个 ref：AlertDialogAction 先关框再跑 @click，开关和「删哪个」共用一个 ref 的话，
// 关框时目标被清掉，handler 里就拿不到了（见 CLAUDE.md 的 Component tests 一节）。

const deleteOpen = ref(false)
const deleting = ref<ProjectSummary | null>(null)

function startDelete(project: ProjectSummary) {
  deleting.value = project
  deleteOpen.value = true
}

const { run: confirmDelete } = useAsyncAction(async () => {
  const target = deleting.value
  if (!target) return

  const wasCurrent = isCurrent(target)
  await projectApi.remove(target.id)
  toast.success("项目已删除")
  await refresh()
  if (wasCurrent) void router.push("/canvas")
}, { errorMessage: "删除失败" })

const rowClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors " +
  "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col md:flex-row">
    <!-- 手机宽度下收成内容区上方的一块可滚动的短列表，避免横向溢出 -->
    <aside
      data-slot="canvas-workspace-nav"
      class="flex max-h-48 w-full shrink-0 flex-col gap-1 overflow-y-auto border-b p-2 md:max-h-none md:w-56 md:border-b-0 md:border-r"
    >
      <RouterLink
        to="/canvas"
        :class="cn(rowClass, 'flex-none', route.path === '/canvas' && 'bg-accent font-medium text-accent-foreground')"
      >
        <UserRoundPen class="size-4 shrink-0" />
        <span class="truncate">个人画布</span>
      </RouterLink>

      <div class="mt-2 flex items-center justify-between pl-2 pr-1">
        <span class="text-xs font-medium text-muted-foreground">项目</span>
        <Button variant="ghost" size="icon-xs" title="新建项目" aria-label="新建项目" @click="openCreate">
          <Plus />
        </Button>
      </div>

      <div v-if="loading && projects.length === 0" class="space-y-1 px-1">
        <Skeleton v-for="i in 3" :key="i" class="h-8 w-full" />
      </div>

      <div v-else-if="error && projects.length === 0" class="space-y-2 px-2 py-1">
        <p class="text-xs text-destructive">{{ error }}</p>
        <Button variant="outline" size="xs" @click="refresh()">重试</Button>
      </div>

      <p v-else-if="projects.length === 0" class="px-2 py-1 text-xs text-muted-foreground">
        还没有项目
      </p>

      <template v-else>
        <div
          v-for="project in projects"
          :key="project.id"
          data-slot="canvas-workspace-project"
          class="group relative flex items-center"
        >
          <RouterLink
            :to="`/projects/${project.id}`"
            :title="project.name"
            :class="cn(rowClass, isCurrent(project) && 'bg-accent font-medium text-accent-foreground')"
          >
            <span class="truncate">{{ project.name }}</span>
          </RouterLink>

          <!-- 非管理员删除服务端会 403，所以连图标都不给 -->
          <Button
            v-if="project.myRole === 'admin'"
            variant="ghost"
            size="icon-xs"
            class="absolute right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            :title="`删除项目「${project.name}」`"
            :aria-label="`删除项目「${project.name}」`"
            @click.stop.prevent="startDelete(project)"
          >
            <Trash2 class="text-destructive" />
          </Button>
        </div>

        <p v-if="total > projects.length" class="px-2 py-1 text-xs text-muted-foreground">
          仅显示前 {{ projects.length }} 个，共 {{ total }} 个项目
        </p>
      </template>
    </aside>

    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <slot />
    </div>

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
              @keydown.enter="submitCreate()"
            />
          </div>
          <div class="space-y-2">
            <Label for="project-desc">描述（可选）</Label>
            <Textarea id="project-desc" v-model="draft.description" rows="3" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="submitting" @click="creating = false">取消</Button>
          <Button :loading="submitting" @click="submitCreate()">创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除项目「{{ deleting?.name }}」？</AlertDialogTitle>
          <AlertDialogDescription>
            项目和其中的全部画布都会对所有成员不可见，且没有恢复入口。
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
