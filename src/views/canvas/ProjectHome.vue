<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { refDebounced } from "@vueuse/core"
import {
  ArrowLeft,
  Check,
  Copy,
  Link2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  UserMinus
} from "lucide-vue-next"
import { toast } from "vue-sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

import { flowApi, projectApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { formatDateTime } from "@/lib/format"
import type {
  FlowSummary,
  ProjectInviteView,
  ProjectMemberView,
  ProjectSummary
} from "@/types/flow"

/**
 * 项目主页 —— **一个路由搞定**：固定的项目头部 + 同页 Tab（画布 / 成员）。
 * 切 Tab 不改 URL、不重新请求、不闪 loading：两个 Tab 的数据进页面时一起取好。
 */

const props = defineProps<{ projectId: string }>()

const route = useRoute()
const router = useRouter()

const project = ref<ProjectSummary | null>(null)
const members = ref<ProjectMemberView[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

const isAdmin = computed(() => project.value?.myRole === "admin")

const { user } = useAuth()
const currentUserId = computed(() => user.value?.id)

usePageTitle("项目", () => project.value?.name)

// —— 画布列表 ——

const flows = ref<FlowSummary[]>([])
const flowTotal = ref(0)
const flowTotalPages = ref(1)
const flowsLoading = ref(true)

const PAGE_SIZE = 20
const page = computed(() => Number(route.query.page ?? 1) || 1)
const keyword = ref(String(route.query.keyword ?? ""))
const debouncedKeyword = refDebounced(keyword, 300)
const sort = ref(String(route.query.sort ?? "updatedAt:desc"))

async function loadProject() {
  loading.value = true
  loadError.value = null
  try {
    const [detail, memberList] = await Promise.all([
      projectApi.get(props.projectId),
      projectApi.members(props.projectId)
    ])
    project.value = detail
    members.value = memberList
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadFlows() {
  flowsLoading.value = true
  try {
    const data = await flowApi.list(props.projectId, {
      page: page.value,
      pageSize: PAGE_SIZE,
      keyword: debouncedKeyword.value.trim() || undefined,
      sort: sort.value
    })
    flows.value = data.items
    flowTotal.value = data.total
    flowTotalPages.value = Math.max(1, data.totalPages)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "画布列表加载失败")
  } finally {
    flowsLoading.value = false
  }
}

watch(() => props.projectId, loadProject, { immediate: true })

watch(
  () => [props.projectId, page.value, debouncedKeyword.value, sort.value] as const,
  () => void loadFlows(),
  { immediate: true }
)

watch(debouncedKeyword, (word) => {
  if (word === String(route.query.keyword ?? "")) return
  void router.replace({ query: { ...route.query, keyword: word || undefined, page: undefined } })
})

watch(sort, (value) => {
  void router.replace({
    query: { ...route.query, sort: value === "updatedAt:desc" ? undefined : value, page: undefined }
  })
})

function goPage(next: number) {
  if (next < 1 || next > flowTotalPages.value) return
  void router.push({ query: { ...route.query, page: next === 1 ? undefined : next } })
}

// —— 项目头部：改名 ——

const editingName = ref(false)
const nameDraft = ref("")

function startRename() {
  if (!isAdmin.value || !project.value) return
  nameDraft.value = project.value.name
  editingName.value = true
}

// 回车提交会顺带触发 blur，两个入口打在同一个动作上，靠它去重
const { run: submitRename } = useAsyncAction(async () => {
  const name = nameDraft.value.trim()
  editingName.value = false
  if (!project.value || !name || name === project.value.name) return

  project.value = await projectApi.update(props.projectId, { name })
}, { errorMessage: "改名失败" })

const deletingProject = ref(false)

const { run: confirmDeleteProject } = useAsyncAction(
  async () => {
    await projectApi.remove(props.projectId)
    toast.success("项目已删除")
    void router.push("/projects")
  },
  { errorMessage: "删除失败" }
)

// —— 画布操作 ——

const creatingFlow = ref(false)
const flowDraft = ref("")

const { run: submitCreateFlow, pending: creatingFlowPending } = useAsyncAction(async () => {
  const name = flowDraft.value.trim()
  if (!name) {
    toast.error("请填写画布名称")
    return
  }
  const flow = await flowApi.create(props.projectId, { name })
  creatingFlow.value = false
  void router.push(`/flows/${flow.id}`)
}, { errorMessage: "创建失败" })

const renamingFlow = ref<FlowSummary | null>(null)
const flowNameDraft = ref("")

function startRenameFlow(flow: FlowSummary) {
  renamingFlow.value = flow
  flowNameDraft.value = flow.name
}

const { run: submitRenameFlow, pending: renamingFlowPending } = useAsyncAction(async () => {
  const target = renamingFlow.value
  const name = flowNameDraft.value.trim()
  renamingFlow.value = null
  if (!target || !name || name === target.name) return

  await flowApi.update(target.id, { name })
  await loadFlows()
}, { errorMessage: "改名失败" })

// 每行各记各的：复制 A 行不该把 B 行的菜单也锁上
const { run: duplicateFlow } = useAsyncAction(
  async (flow: FlowSummary) => {
    const copy = await flowApi.duplicate(flow.id)
    toast.success(`已复制为「${copy.name}」`)
    await loadFlows()
  },
  { errorMessage: "复制失败", key: (flow) => flow.id }
)

/**
 * 二次确认对话框：开关和「操作哪一个」要分开两个 ref。
 * AlertDialogAction 是先关对话框、再跑透传下来的 @click，
 * 合成一个 ref 的话 handler 里读到的永远是关闭时清掉的 null，请求就发不出去。
 */
const deletingFlow = ref<FlowSummary | null>(null)
const deleteFlowOpen = ref(false)

function startDeleteFlow(flow: FlowSummary) {
  deletingFlow.value = flow
  deleteFlowOpen.value = true
}

const { run: confirmDeleteFlow } = useAsyncAction(async () => {
  const target = deletingFlow.value
  if (!target) return

  await flowApi.remove(target.id)
  await Promise.all([loadFlows(), loadProject()])
}, { errorMessage: "删除失败" })

// —— 成员与邀请 ——

const removingMember = ref<ProjectMemberView | null>(null)
const removeMemberOpen = ref(false)

function startRemoveMember(member: ProjectMemberView) {
  removingMember.value = member
  removeMemberOpen.value = true
}

const { run: confirmRemoveMember } = useAsyncAction(async () => {
  const target = removingMember.value
  if (!target) return

  await projectApi.removeMember(props.projectId, target.userId)
  await loadProject()
  toast.success("已移除该成员")
}, { errorMessage: "移除失败" })

/**
 * 分享链接：**一个项目一条**，面板一打开就有 —— 没有「生成」这一步。
 * 不限使用人数，唯一的开关是有效期；链接发漏了就「重置」，换一个 token。
 */
const sharePanel = ref(false)
const invite = ref<ProjectInviteView | null>(null)
const inviteExpiry = ref("7")
const copied = ref(false)
const resetOpen = ref(false)

/** 用剩余时间反推当前落在哪个档，下拉才不会显示一个跟事实无关的默认值 */
function expiryBucket(expiresAt: string) {
  const days = (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  if (days <= 1) return "1"
  if (days <= 7) return "7"
  return "30"
}

const { run: openSharePanel, pending: inviteLoading } = useAsyncAction(async () => {
  sharePanel.value = true
  copied.value = false
  const link = await projectApi.invite(props.projectId)
  invite.value = link
  inviteExpiry.value = expiryBucket(link.expiresAt)
}, { errorMessage: "分享链接加载失败" })

/** 点输入框就全选：剪贴板不可用时还能手动复制 */
function selectAllText(event: FocusEvent) {
  ;(event.target as HTMLInputElement | null)?.select()
}

async function copyShareLink() {
  const link = invite.value
  if (!link) return

  try {
    await navigator.clipboard.writeText(link.url)
    copied.value = true
    toast.success("分享链接已复制")
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // 剪贴板不可用（http 或没授权）时不算失败，链接在界面上照样能手选
    toast.info("复制失败，请手动选中链接复制")
  }
}

/** 切档即续期，token 不变 —— 已经发出去的链接不该因为改有效期而失效 */
const { run: changeExpiry, pending: expiryPending } = useAsyncAction(
  async (value: string) => {
    const days = Number(value)
    if (!invite.value || expiryBucket(invite.value.expiresAt) === value) return

    invite.value = await projectApi.setInviteExpiry(props.projectId, days)
    toast.success(`有效期已改为 ${days} 天`)
  },
  {
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "修改有效期失败")
      // 失败了把下拉拨回真实值，否则界面显示的档跟服务端不是一回事
      if (invite.value) inviteExpiry.value = expiryBucket(invite.value.expiresAt)
    }
  }
)

const { run: confirmResetInvite } = useAsyncAction(async () => {
  invite.value = await projectApi.resetInvite(props.projectId, Number(inviteExpiry.value))
  copied.value = false
  toast.success("已换成新链接，旧链接立即失效")
}, { errorMessage: "重置失败" })

function initials(member: ProjectMemberView) {
  const source = member.name ?? member.username ?? member.email ?? "?"
  return source.slice(0, 1).toUpperCase()
}

function displayName(member: ProjectMemberView) {
  return member.name ?? member.username ?? member.email ?? member.userId
}
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-9 w-64" />
      <Skeleton class="h-64 w-full" />
    </div>

    <div
      v-else-if="loadError || !project"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <p class="text-sm text-destructive">{{ loadError ?? "项目不存在" }}</p>
      <Button variant="outline" size="sm" @click="router.push('/projects')">返回项目列表</Button>
    </div>

    <template v-else>
      <!-- 项目头部：常驻，不随 Tab 切换 -->
      <header class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <Button variant="ghost" size="sm" class="-ml-2 mb-1" @click="router.push('/projects')">
            <ArrowLeft />
            全部项目
          </Button>

          <Input
            v-if="editingName"
            v-model="nameDraft"
            class="h-9 max-w-sm text-xl font-semibold"
            autofocus
            @blur="submitRename()"
            @keydown.enter="submitRename()"
            @keydown.esc="editingName = false"
          />
          <h1
            v-else
            class="truncate text-2xl font-semibold tracking-tight"
            :class="isAdmin ? 'cursor-text hover:text-primary' : ''"
            :title="isAdmin ? '点击改名' : undefined"
            @click="startRename"
          >
            {{ project.name }}
          </h1>

          <p v-if="project.description" class="mt-1 text-sm text-muted-foreground">
            {{ project.description }}
          </p>
        </div>

        <div v-if="isAdmin" class="flex shrink-0 items-center gap-2">
          <Button variant="outline" :loading="inviteLoading" @click="openSharePanel()">
            <Link2 />
            分享
          </Button>
          <Button variant="ghost" size="icon" title="删除项目" @click="deletingProject = true">
            <Trash2 class="text-destructive" />
          </Button>
        </div>
      </header>

      <!-- 同页 Tab：切换不改路由、不重新请求 -->
      <Tabs default-value="flows" class="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList>
          <TabsTrigger value="flows">画布 {{ flowTotal }}</TabsTrigger>
          <TabsTrigger value="members">成员 {{ members.length }}</TabsTrigger>
        </TabsList>

        <!-- Tab 1 · 画布 -->
        <TabsContent value="flows" class="flex min-h-0 flex-1 flex-col gap-4">
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

            <Button class="ml-auto" @click="((flowDraft = ''), (creatingFlow = true))">
              <Plus />
              新建画布
            </Button>
          </div>

          <div v-if="flowsLoading" class="space-y-2">
            <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
          </div>

          <div
            v-else-if="flows.length === 0"
            class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
          >
            <p class="text-sm text-muted-foreground">
              {{ keyword ? "没有匹配的画布" : "这个项目还没有画布" }}
            </p>
            <Button
              v-if="!keyword"
              variant="outline"
              size="sm"
              @click="((flowDraft = ''), (creatingFlow = true))"
            >
              新建画布
            </Button>
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
                          <DropdownMenuItem @select="startRenameFlow(flow)">重命名</DropdownMenuItem>
                          <DropdownMenuItem @select="duplicateFlow(flow)">复制</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" @select="startDeleteFlow(flow)">
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
              <span>共 {{ flowTotal }} 张画布</span>
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" :disabled="page <= 1" @click="goPage(page - 1)">
                  上一页
                </Button>
                <span class="tabular-nums">{{ page }} / {{ flowTotalPages }}</span>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="page >= flowTotalPages"
                  @click="goPage(page + 1)"
                >
                  下一页
                </Button>
              </div>
            </div>
          </template>
        </TabsContent>

        <!-- Tab 2 · 成员 -->
        <TabsContent value="members" class="flex min-h-0 flex-1 flex-col gap-4">
          <div class="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead class="w-28">角色</TableHead>
                  <TableHead class="w-44">加入时间</TableHead>
                  <TableHead class="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="member in members" :key="member.userId">
                  <TableCell>
                    <div class="flex items-center gap-3">
                      <!-- bg-muted 是给默认头像垫的底：那张图是透明底的像素方块 -->
                      <Avatar class="size-8 bg-muted">
                        <AvatarImage
                          v-if="member.avatarUrl"
                          :src="member.avatarUrl"
                          :alt="displayName(member)"
                        />
                        <AvatarFallback>{{ initials(member) }}</AvatarFallback>
                      </Avatar>
                      <div class="min-w-0">
                        <div class="truncate font-medium">{{ displayName(member) }}</div>
                        <div v-if="member.email" class="truncate text-xs text-muted-foreground">
                          {{ member.email }}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge :variant="member.role === 'admin' ? 'default' : 'secondary'">
                      {{ member.role === "admin" ? "管理员" : "成员" }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-sm text-muted-foreground">
                    {{ formatDateTime(member.joinedAt) }}
                  </TableCell>
                  <TableCell>
                    <!-- 管理员不能移除自己 -->
                    <Button
                      v-if="isAdmin && member.userId !== currentUserId"
                      variant="ghost"
                      size="icon"
                      title="移出项目"
                      @click="startRemoveMember(member)"
                    >
                      <UserMinus class="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <p v-if="isAdmin" class="text-sm text-muted-foreground">
            加入项目的唯一方式是分享链接 —— 点右上角的「分享」把链接发给对方。
          </p>
        </TabsContent>
      </Tabs>
    </template>

    <!-- 新建画布 -->
    <Dialog v-model:open="creatingFlow">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建画布</DialogTitle>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="flow-name">名称</Label>
          <Input
            id="flow-name"
            v-model="flowDraft"
            placeholder="例如：下单主流程"
            maxlength="80"
            @keydown.enter="submitCreateFlow()"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creatingFlowPending" @click="creatingFlow = false">
            取消
          </Button>
          <Button :loading="creatingFlowPending" @click="submitCreateFlow()">创建并打开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 重命名画布 -->
    <Dialog :open="renamingFlow !== null" @update:open="(v) => !v && (renamingFlow = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名画布</DialogTitle>
        </DialogHeader>
        <Input v-model="flowNameDraft" maxlength="80" @keydown.enter="submitRenameFlow()" />
        <DialogFooter>
          <Button variant="outline" :disabled="renamingFlowPending" @click="renamingFlow = null">
            取消
          </Button>
          <Button :loading="renamingFlowPending" @click="submitRenameFlow()">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 分享面板：一打开就有链接，没有「生成」这一步 -->
    <Dialog v-model:open="sharePanel">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>分享项目</DialogTitle>
          <DialogDescription>
            把链接发给对方，打开即可加入本项目。不限人数，链接是加入本项目的唯一方式。
          </DialogDescription>
        </DialogHeader>

        <p v-if="inviteLoading" class="text-sm text-muted-foreground">加载中…</p>

        <template v-else-if="invite">
          <!-- 链接是主角：一行就是「链接 + 复制」，有效期在下面当脚注 -->
          <div class="flex w-full min-w-0 items-center gap-2">
            <Input
              :model-value="invite.url"
              readonly
              class="min-w-0 flex-1 font-mono text-xs"
              @focus="selectAllText"
            />
            <Button class="shrink-0" @click="copyShareLink">
              <Check v-if="copied" />
              <Copy v-else />
              {{ copied ? "已复制" : "复制" }}
            </Button>
          </div>

          <div class="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span class="shrink-0">有效期</span>
            <Select
              v-model="inviteExpiry"
              :disabled="expiryPending"
              @update:model-value="(v) => changeExpiry(String(v))"
            >
              <SelectTrigger class="h-7 w-24 shrink-0 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 天</SelectItem>
                <SelectItem value="7">7 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
              </SelectContent>
            </Select>
            <span class="truncate">{{ formatDateTime(invite.expiresAt) }} 过期</span>
            <Button
              variant="ghost"
              size="sm"
              class="ml-auto h-7 shrink-0 text-xs"
              @click="resetOpen = true"
            >
              重置链接
            </Button>
          </div>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 各种二次确认 -->
    <AlertDialog v-model:open="deletingProject">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除项目「{{ project?.name }}」？</AlertDialogTitle>
          <AlertDialogDescription>
            项目和其中的全部画布都会对所有成员不可见，且没有恢复入口。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmDeleteProject()">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog v-model:open="deleteFlowOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除画布「{{ deletingFlow?.name }}」？</AlertDialogTitle>
          <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmDeleteFlow()">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog v-model:open="resetOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>重置分享链接？</AlertDialogTitle>
          <AlertDialogDescription>
            会换成一条新链接，之前发出去的链接立刻失效。已经加入的成员不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmResetInvite()">重置</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog v-model:open="removeMemberOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            把 {{ removingMember ? displayName(removingMember) : "" }} 移出项目？
          </AlertDialogTitle>
          <!--
            这两句都是事实，不能只写第一句：分享链接是一条、可无限次使用、只看有效期，
            对方手里若还留着当初进来用的那条，移除之后自己点一下就能回来。
            不说的话，管理员会以为「移除」等于「收回权限」。
          -->
          <AlertDialogDescription>
            移除后对方立刻访问不到本项目及其中的画布，正在编辑的人会在几十秒内断开。
            注意：分享链接可以重复使用，对方若还留着那条链接可以自行重新加入——
            要彻底断掉，请在分享面板里重置链接。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction @click="confirmRemoveMember()">移除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
