<script setup lang="ts">
import { type Component, computed, onMounted, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { toast } from "vue-sonner"
import { KeyRound, Link2Off, ShieldCheck } from "@lucide/vue"

// GitHub 的标识不在图标库里 —— lucide v1 把 brand 图标整类下架了，见该文件注释
import GithubMark from "@/components/icons/GithubMark.vue"

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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

import { useAsyncAction } from "@/composables/useAsyncAction"
import { authApi } from "@/lib/api"
import { fetchSession } from "@/lib/auth"
import { formatDateTime } from "@/lib/format"
import type {
  AuthIdentity,
  AuthProviderView,
  PendingLink,
  ProviderId
} from "@/types/auth"

/**
 * 「登录方式」卡片。
 *
 * 一个用户可以绑多条登录方式（Keycloak / GitHub），用其中任意一条都能登进
 * 同一个账号。**至少要留一条** —— 只剩一条时按钮就禁掉，服务端那边还会再挡
 * 一次 409：禁用只是提示，判定必须在服务端。
 *
 * 关联走的是**整页跳转**而不是 XHR：要经过第三方的授权页，SPA 内部跳没用
 * （和登录、登出是同一个道理）。
 *
 * 授权回来之后**还没绑上** —— 服务端只是暂存了一条待确认的，这里弹确认框把
 * 「你要关联的是 @某某」摆出来，点了才真的写。这一步是必需的：提供方那边可能
 * 正登着别人的账号（共用电脑最典型），而 OAuth App 授权过一次之后连确认页都不再弹，
 * 整趟对用户是无感的，所以「绑的到底是谁」只能由我们问。
 *
 * 失败的情况（比如那个账号已被别人绑走）走 `?link_error=`，读一次就把 query 洗掉。
 */

const route = useRoute()
const router = useRouter()

const identities = ref<AuthIdentity[]>([])
const providers = ref<AuthProviderView[]>([])
const loading = ref(true)

/**
 * 从第三方授权回来后**等着被确认**的那条关联。
 *
 * 它跟着列表一起从服务端拿，而不是靠 URL 上的参数触发 —— 这样用户中途关了标签页
 * 再回到设置页，确认框照样会出现，不会留下一条谁也想不起来的半截绑定。
 */
const pendingLink = ref<PendingLink | null>(null)
const confirmingLink = ref(false)

/** 每个提供方一个图标；认不出来的用一把钥匙兜底 */
const ICONS: Partial<Record<ProviderId, Component>> = {
  keycloak: KeyRound,
  github: GithubMark
}

const iconOf = (provider: ProviderId) => ICONS[provider] ?? KeyRound

/** 还没绑的那些才给「关联」入口：一个提供方只留一条 */
const linkable = computed(() =>
  providers.value.filter(
    (provider) => !identities.value.some((item) => item.provider === provider.id)
  )
)

/** 只剩一条时不许解绑 —— 解掉就再也登不进来了，这里没有邮箱找回 */
const canUnlink = computed(() => identities.value.length > 1)

async function load() {
  try {
    const [list, config] = await Promise.all([
      authApi.identities(),
      authApi.config()
    ])
    identities.value = list.items
    providers.value = config.providers
    pendingLink.value = list.pending
    confirmingLink.value = Boolean(list.pending)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "读取登录方式失败")
  } finally {
    loading.value = false
  }
}

/**
 * 关联流程**失败**时跳回来带的原因（成功不带参数，走的是确认框那条路）。
 * 读一次就把 query 洗掉 —— 留着的话刷新一次会再提示一遍。
 */
function consumeLinkError() {
  const failure = route.query.link_error
  if (typeof failure !== "string") return

  toast.error(failure)
  const query = { ...route.query }
  delete query.link_error
  void router.replace({ path: route.path, query })
}

onMounted(() => {
  consumeLinkError()
  void load()
})

/**
 * 解绑。两个 ref 而不是一个：`AlertDialogAction` 会**先关掉对话框、再**跑转发
 * 出来的 @click，只用一个 ref 存「解哪一条」的话，处理函数读到的已经是被关闭
 * 动作清掉的值，请求就悄悄没发出去（见 ProjectHome.test.ts 里钉住的那条）。
 */
const confirming = ref(false)
const pendingTarget = ref<AuthIdentity | null>(null)

function askUnlink(item: AuthIdentity) {
  pendingTarget.value = item
  confirming.value = true
}

/**
 * 确认那条待关联。**这一步才真的写库** —— 之前的整趟授权对用户可能完全无感
 * （提供方那边已登录 + 已授权过 = 连确认页都不弹），所以「绑的到底是谁」
 * 这一问只能在这里问。
 */
const { run: confirmLink } = useAsyncAction(
  async () => {
    const { identity } = await authApi.confirmLink()
    identities.value = [...identities.value, identity]
    pendingLink.value = null
    confirmingLink.value = false
    toast.success(`已关联 ${identity.label}`)
  },
  {
    onError: (err) => {
      // 失败时服务端已经把暂存清掉了，前端也别再留着一个点不动的框
      pendingLink.value = null
      confirmingLink.value = false
      toast.error(err instanceof Error ? err.message : "关联失败")
    }
  }
)

/** 放弃这条待关联 */
const { run: cancelLink } = useAsyncAction(
  async () => {
    await authApi.cancelLink()
    pendingLink.value = null
    confirmingLink.value = false
  },
  { errorMessage: "取消失败" }
)

const { run: unlink, isPending } = useAsyncAction(
  async (item: AuthIdentity) => {
    await authApi.unlinkIdentity(item.id)
    identities.value = identities.value.filter((row) => row.id !== item.id)
    toast.success(`已解绑 ${item.label}`)
    // 解掉主身份会让服务端提升另一条，用户档案可能跟着变，重新问一次登录态
    await fetchSession(true)
  },
  { key: (item) => item.id, errorMessage: "解绑失败" }
)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>登录方式</CardTitle>
      <CardDescription>
        关联多个账号后，用其中任意一个都能登进这同一个用户。至少要保留一种。
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <p v-if="loading" class="text-sm text-muted-foreground">读取中…</p>

      <ul v-else class="space-y-2" data-testid="identity-list">
        <li
          v-for="item in identities"
          :key="item.id"
          class="flex flex-wrap items-center gap-3 rounded-md border p-3"
          :data-provider="item.provider"
        >
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <component :is="iconOf(item.provider)" class="size-4" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <p class="truncate font-medium">{{ item.label }}</p>
              <!--
                主身份要标出来：解绑它会让显示名/头像换成另一条账号的，
                不写明白的话那次变化看起来像是没来由的。
              -->
              <Badge v-if="item.primary" variant="secondary" class="gap-1">
                <ShieldCheck class="size-3" />
                主身份
              </Badge>
            </div>
            <p class="truncate text-sm text-muted-foreground">
              {{ item.username || item.email || "—" }}
              <span class="text-xs">
                · 关联于 {{ formatDateTime(item.createdAt) }}
              </span>
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            :disabled="!canUnlink"
            :loading="isPending(item.id)"
            :title="canUnlink ? undefined : '至少要保留一种登录方式'"
            :data-testid="`unlink-${item.provider}`"
            @click="askUnlink(item)"
          >
            <Link2Off class="size-4" />
            解绑
          </Button>
        </li>
      </ul>

      <template v-if="!loading && linkable.length">
        <Separator />
        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-for="provider in linkable"
            :key="provider.id"
            variant="outline"
            size="sm"
            :data-testid="`link-${provider.id}`"
            @click="authApi.startLink(provider.id)"
          >
            <component :is="iconOf(provider.id)" class="size-4" />
            关联 {{ provider.label }}
          </Button>
          <p class="text-xs text-muted-foreground">
            会跳到对应的登录页完成授权，再跳回这里。
          </p>
        </div>
      </template>
    </CardContent>
  </Card>

  <!--
    关联确认。**关掉它是允许的第三条路** —— 待确认那条存在服务端而不是这一页上，
    所以按 Esc 只是「等会儿再说」：什么都没绑，下次进设置页会再问一遍，
    十分钟没人理就自己过期。真正要守的是「不确认就不写库」，那一条在服务端。
  -->
  <AlertDialog v-model:open="confirmingLink">
    <AlertDialogContent data-testid="confirm-link">
      <AlertDialogHeader>
        <AlertDialogTitle>
          确认关联这个 {{ pendingLink?.label }} 账号？
        </AlertDialogTitle>
        <AlertDialogDescription>
          关联之后，用它登录就能进入你当前这个账号。
          <strong class="text-foreground">请先核对下面是不是你本人的账号</strong>
          —— 如果这台电脑上还登着别人的
          {{ pendingLink?.label }}，授权会直接跳过确认页，绑上的就会是那个人。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <!-- 把账号本身摆出来：这是整个确认步骤存在的唯一理由 -->
      <div
        v-if="pendingLink"
        class="flex items-center gap-3 rounded-md border p-3"
        data-testid="pending-account"
      >
        <img
          v-if="pendingLink.avatarUrl"
          :src="pendingLink.avatarUrl"
          alt=""
          class="size-10 shrink-0 rounded-full bg-muted object-cover"
        />
        <span
          v-else
          class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <component :is="iconOf(pendingLink.provider)" class="size-4" />
        </span>
        <div class="min-w-0">
          <p class="truncate font-medium">{{ pendingLink.username || "（无用户名）" }}</p>
          <p class="truncate text-sm text-muted-foreground">
            {{ pendingLink.email || "未提供邮箱" }}
          </p>
        </div>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel @click="cancelLink()">不是我，取消</AlertDialogCancel>
        <AlertDialogAction data-testid="confirm-link-submit" @click="confirmLink()">
          确认关联
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <!-- 解绑确认：确认之后才真的发请求 -->
  <AlertDialog v-model:open="confirming">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>解绑 {{ pendingTarget?.label }}？</AlertDialogTitle>
        <AlertDialogDescription>
          解绑后就不能再用这个账号登录了，但可以随时重新关联。当前的登录状态不受影响。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction @click="pendingTarget && unlink(pendingTarget)">
          <Link2Off class="size-4" />
          解绑
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
