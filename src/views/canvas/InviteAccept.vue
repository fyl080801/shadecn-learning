<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"
import { Loader2, MailX, Users } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { inviteApi } from "@/lib/api"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { InvitePreview } from "@/types/flow"

/**
 * 邀请落地页。
 *
 * **不做点开即加入** —— 先让用户看清自己要进的是哪个项目，再点确认。
 * 未登录的访问由服务端页面网关（server/frontend/guard.ts）302 到登录页，
 * 登录完会带着 redirect 跳回这里，所以这里不用自己处理未登录。
 */

const props = defineProps<{ token: string }>()
const router = useRouter()

const preview = ref<InvitePreview | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

usePageTitle("加入项目", () => preview.value?.projectName)

onMounted(async () => {
  try {
    preview.value = await inviteApi.preview(props.token)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

// 连点只会 accept 一次：重复的 accept 虽然幂等，但会白跑一趟、还可能抢在跳转前弹错
const { run: join, pending: joining } = useAsyncAction(
  async () => {
    const data = preview.value
    if (!data) return

    // 已经是成员就没必要再调 accept，直接进项目
    if (data.alreadyMember && data.projectId) {
      void router.replace(`/projects/${data.projectId}`)
      return
    }

    const { projectId } = await inviteApi.accept(props.token)
    void router.replace(`/projects/${projectId}`)
  },
  {
    // 这页没有 toast，错误直接写在卡片里
    onError: (err) => {
      error.value = err instanceof Error ? err.message : "加入失败"
    }
  }
)
</script>

<template>
  <div class="flex h-full items-center justify-center p-6">
    <Card class="w-full max-w-md">
      <template v-if="loading">
        <CardContent class="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 class="size-4 animate-spin" />
          正在校验邀请链接…
        </CardContent>
      </template>

      <!-- 失效：各给各的文案，不是一律「链接无效」 -->
      <template v-else-if="!preview?.valid">
        <CardHeader class="items-center text-center">
          <MailX class="size-8 text-muted-foreground" />
          <CardTitle>{{ preview?.message ?? error ?? "邀请链接无效" }}</CardTitle>
          <CardDescription>请联系项目管理员重新发一条邀请链接。</CardDescription>
        </CardHeader>
        <CardContent class="flex justify-center">
          <Button variant="outline" @click="router.push('/projects')">去我的项目</Button>
        </CardContent>
      </template>

      <template v-else>
        <CardHeader class="items-center text-center">
          <Users class="size-8 text-primary" />
          <CardTitle>
            {{ preview.alreadyMember ? "你已经在这个项目里了" : "你被邀请加入" }}
          </CardTitle>
          <CardDescription>
            <span class="font-medium text-foreground">{{ preview.projectName }}</span>
            · {{ preview.memberCount }} 位成员
          </CardDescription>
        </CardHeader>

        <CardContent class="flex flex-col gap-2">
          <p v-if="error" class="text-center text-sm text-destructive">{{ error }}</p>

          <Button :loading="joining" @click="join()">
            {{ preview.alreadyMember ? "进入项目" : "加入项目" }}
          </Button>
          <Button variant="ghost" @click="router.push('/projects')">取消</Button>
        </CardContent>
      </template>
    </Card>
  </div>
</template>
