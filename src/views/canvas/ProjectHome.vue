<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { ArrowLeft, Check, Copy, Link2, Trash2, UserMinus } from "lucide-vue-next"
import { toast } from "vue-sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

import FlowList from "@/components/canvas/FlowList.vue"
import { projectApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { formatDateTime } from "@/lib/format"
import type { ProjectInviteView, ProjectMemberView, ProjectSummary } from "@/types/flow"

/**
 * 项目主页 —— **一个路由搞定**：固定的项目头部 + 同页 Tab（画布 / 成员）。
 * 切 Tab 不改 URL、不重新请求、不闪 loading：两个 Tab 的数据进页面时一起取好。
 */

const props = defineProps<{ projectId: string }>()

const router = useRouter()

const project = ref<ProjectSummary | null>(null)
const members = ref<ProjectMemberView[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
/** 正在把个人空间换到 /personal 去，见 loadProject */
const redirecting = ref(false)

const isAdmin = computed(() => project.value?.myRole === "admin")

const { user } = useAuth()
const currentUserId = computed(() => user.value?.id)

usePageTitle("项目", () => project.value?.name)

async function loadProject() {
  loading.value = true
  loadError.value = null
  try {
    const [detail, memberList] = await Promise.all([
      projectApi.get(props.projectId),
      projectApi.members(props.projectId)
    ])
    /**
     * 个人空间在库里确实是个 `kind='personal'` 的项目，`/projects/<它的 id>` 也确实
     * 打得开 —— 但这一页给它看的是成员、分享、删除项目，而这三样对它全是 403。
     * 它的页面是 `/personal`，所以这里直接换过去（`replace`：这个地址不该留在返回栈里）。
     * 老书签和历史记录是唯一还会走到这儿的路。
     */
    if (detail.kind === "personal") {
      // 跳转要一帧才生效，这一帧里 project 还是 null —— 不举旗的话会闪一下「项目不存在」
      redirecting.value = true
      void router.replace("/personal")
      return
    }

    project.value = detail
    members.value = memberList
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, loadProject, { immediate: true })

// —— 画布列表 ——
//
// 列表本身（搜索 / 排序 / 分页 / 增删改）在 `FlowList` 里，个人画布页
// （`PersonalFlows.vue`）用的是同一个组件。这里只留下 Tab 标题要显示的那个数。

const flowTotal = ref(0)

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
    <div v-if="loading || redirecting" class="space-y-4">
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
          <!-- 只有这一个列表，所以页码 / 关键字写进 URL；刷新、分享链接都能停在原处 -->
          <FlowList
            v-model:total="flowTotal"
            :project-id="projectId"
            sync-query
            @changed="loadProject"
          />
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
