<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { KeyRound, LogIn, TriangleAlert } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import GithubMark from "@/components/icons/GithubMark.vue"
import type { AuthProviderView, ProviderId } from "@/types/auth"

/**
 * 登录页。**不是 SPA 的一个路由**，而是 `login.html` 这个第二入口挂载的独立应用
 * （`src/login/main.ts`）—— 未登录时后端只发 `/login`，`index.html` 根本发不出去，
 * 所以登录页不能长在需要 `index.html` 才能启动的那棵树上。
 *
 * 它以前是服务端拼的一段 HTML 字符串（`server/frontend/login-page.ts`），
 * 换成这里之后消掉了两处必须手工同步的重复：深色调色板（曾经真的漂过一次，
 * `--primary` 一边 0.985 一边 0.922）和 GitHub 的 SVG。现在配色直接来自
 * `@/style.css`，图标直接来自 `@/components/icons/GithubMark.vue`。
 *
 * 页面需要的三样东西都不用服务端注入：
 * - 有哪些登录方式 → `GET /api/auth/config`（公开端点，匿名可读）
 * - 登完回哪儿 → `?redirect=`，原样透传给 `/api/auth/login`，**由服务端做站内校验**
 *   （`safeRedirect`），前端不重复实现一遍那套判断
 * - 失败原因 → `?error=`，用文本插值渲染，转义交给 Vue，不再手写 escapeHtml
 */

const providers = ref<AuthProviderView[]>([])
const enabled = ref(true)
const loading = ref(true)

const params = new URLSearchParams(window.location.search)
const redirect = params.get("redirect") ?? "/"
const error = params.get("error")

/** 提供方图标；没有对应图标的就不画，一排一样的图标比没有更难分辨 */
const ICONS: Partial<Record<ProviderId, unknown>> = { github: GithubMark }

const subtitle = computed(() => {
  if (loading.value) return "正在读取可用的登录方式…"
  if (!enabled.value) return "登录不可用"
  return providers.value.length > 1
    ? "选一种方式继续"
    : `用${providers.value[0]?.label ?? ""}账号继续`
})

function loginHref(provider: ProviderId) {
  return `/api/auth/login?provider=${provider}&redirect=${encodeURIComponent(redirect)}`
}

onMounted(async () => {
  try {
    const res = await fetch("/api/auth/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    })
    const data = (await res.json()) as {
      enabled: boolean
      providers: AuthProviderView[]
    }
    enabled.value = data.enabled
    providers.value = data.providers
  } catch (err) {
    // 读不到就当没有可用方式，下面会给出「服务端没配」的提示
    console.error("[login] 读取登录方式失败", err)
    enabled.value = false
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-6">
    <Card class="w-full max-w-sm">
      <CardHeader class="items-center text-center">
        <span
          class="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          <LogIn class="size-6" />
        </span>
        <CardTitle class="mt-3 text-xl">登录</CardTitle>
        <CardDescription>{{ subtitle }}</CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <p
          v-if="error"
          role="alert"
          data-testid="login-error"
          class="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" />
          <span class="min-w-0 break-words">{{ error }}</span>
        </p>

        <p
          v-if="!loading && !enabled"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="login-disabled"
        >
          服务端没有配置任何登录方式（KEYCLOAK_ISSUER / KEYCLOAK_CLIENT_ID 或
          GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。
        </p>

        <div v-if="!loading && enabled" class="grid gap-2.5">
          <!--
            第一个是主按钮，其余描边 —— 几个入口并排且样式相同的话，
            「平时该点哪个」每次都得重新读一遍。
          -->
          <Button
            v-for="(provider, at) in providers"
            :key="provider.id"
            as="a"
            :href="loginHref(provider.id)"
            rel="nofollow"
            :variant="at === 0 ? 'default' : 'outline'"
            size="lg"
            :data-testid="`login-${provider.id}`"
          >
            <component :is="ICONS[provider.id] ?? KeyRound" class="size-4" />
            {{ provider.buttonLabel }}
          </Button>
        </div>

        <p class="text-center text-xs text-muted-foreground">
          会跳到对应的登录页完成认证，再带着会话跳回来
        </p>
      </CardContent>
    </Card>
  </main>
</template>
