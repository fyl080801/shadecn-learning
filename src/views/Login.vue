<script setup lang="ts">
import { computed, ref } from "vue"
import { useRoute } from "vue-router"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { AlertTriangle, KeyRound, LoaderCircle } from "lucide-vue-next"
import { useAuth } from "@/lib/auth"

const route = useRoute()
const { authEnabled, startLogin } = useAuth()

const redirecting = ref(false)

/** 回调失败时后端会把原因塞在 ?error= 里 */
const error = computed(() => {
  const raw = route.query.error
  return typeof raw === "string" && raw ? raw : ""
})

/** 登录成功后要回到哪儿 */
const redirectTo = computed(() => {
  const raw = route.query.redirect
  return typeof raw === "string" && raw.startsWith("/") ? raw : "/"
})

const signIn = () => {
  redirecting.value = true
  startLogin(redirectTo.value)
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center bg-muted/30 p-6">
    <Card class="w-full max-w-sm">
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          <KeyRound class="size-6" />
        </div>
        <CardTitle class="text-xl">登录</CardTitle>
        <CardDescription>用 Keycloak 账号继续</CardDescription>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <div
          v-if="error"
          class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <span class="break-all">{{ error }}</span>
        </div>

        <div
          v-if="!authEnabled"
          class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          服务端没有配置 Keycloak（KEYCLOAK_ISSUER / KEYCLOAK_CLIENT_ID），
          当前所有页面按匿名放行。
        </div>

        <Button
          class="w-full"
          size="lg"
          :disabled="!authEnabled || redirecting"
          @click="signIn"
        >
          <LoaderCircle v-if="redirecting" class="size-4 animate-spin" />
          <KeyRound v-else class="size-4" />
          {{ redirecting ? "正在跳转 Keycloak…" : "使用 Keycloak 登录" }}
        </Button>
      </CardContent>

      <CardFooter class="justify-center">
        <p class="text-xs text-muted-foreground">
          会跳到 Keycloak 完成认证，再带着会话跳回来
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
