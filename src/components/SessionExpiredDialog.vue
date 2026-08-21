<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue"
import { useIntervalFn } from "@vueuse/core"
import { toast } from "vue-sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { finishReLogin, isLoginDone, openLoginWindow, useAuth } from "@/lib/auth"

/**
 * 会话过期的全局提示。跟 Toaster 一样在 App.vue 里挂一次：
 * 任何一个接口拿到 401 都会打开它（见 lib/auth.ts 的 apiFetch / requestReLogin）。
 *
 * 它只是个**提示**，三条出路：退出、重新登录、直接关掉什么都不做
 * （页面和没提交的内容原样保留）。
 *
 * 「重新登录」**新开一个窗口**走完整套 OIDC，当前页一动不动。之所以不再用模态里的
 * iframe：Keycloak 默认的 `X-Frame-Options: SAMEORIGIN` 会让 iframe 一片空白，
 * 而新窗口是顶层上下文，既不受它限制，Keycloak 自己的 SSO Cookie 也还是 first-party，
 * 常常连密码都不用再输一次。
 *
 * 登录成功怎么知道？两条腿：
 *   - 服务端那张 /auth/login-done 落地页 postMessage 回来（快）；
 *   - 每 3 秒问一次 /api/auth/me（兜底：消息被拦，或 opener 被中间页面切断）。
 * 会话是 httpOnly cookie，前端只能这么确认。
 */
const { sessionExpired, dismissReLogin, logoutFromExpired } = useAuth()

/** 登录窗口开着（或刚开过还没登上）——期间监听消息 + 轮询 */
const waiting = ref(false)
let loginWindow: Window | null = null

function startLogin() {
  const opened = openLoginWindow()
  if (!opened) {
    toast.error("浏览器拦截了登录窗口，请允许弹出窗口后重试")
    return
  }
  loginWindow = opened
  loginWindow.focus()
  waiting.value = true
}

/** 关掉提示（Esc / 点遮罩 / 右上角 × / 「稍后再说」）：什么都不做 */
function onOpenChange(open: boolean) {
  if (!open) dismissReLogin()
}

/** 真的登上了才收工；没登上（比如登录失败停在错误页）就继续等 */
async function settle() {
  if (!(await finishReLogin())) return false
  toast.success("已重新登录")
  return true
}

function onMessage(event: MessageEvent) {
  if (!isLoginDone(event)) return
  void settle()
}

// 轮询只在等待期间跑：没在等就停，免得白白发请求
const poll = useIntervalFn(
  async () => {
    if (await settle()) return
    // 窗口被用户关掉了又没登上：别一直轮询，把按钮还给他重开一次
    if (loginWindow?.closed) waiting.value = false
  },
  3000,
  { immediate: false }
)

watch(waiting, (on) => {
  if (on) {
    window.addEventListener("message", onMessage)
    poll.resume()
  } else {
    window.removeEventListener("message", onMessage)
    poll.pause()
    loginWindow = null
  }
})

// 提示被关掉（用户关的，或别处直接调了 dismiss / 登录成功）：等待状态跟着结束
watch(sessionExpired, (expired) => {
  if (!expired) waiting.value = false
})

onBeforeUnmount(() => window.removeEventListener("message", onMessage))
</script>

<template>
  <Dialog :open="sessionExpired" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>登录状态已失效</DialogTitle>
        <DialogDescription>
          你的登录状态已经过期，后端不再受理请求。可以在新窗口里重新登录（这一页和没提交
          的内容都还在），也可以退出到登录页；直接关掉这个窗口则什么都不做。
        </DialogDescription>
      </DialogHeader>

      <p v-if="waiting" class="text-muted-foreground text-sm">
        已在新窗口打开登录页，登录完成后这里会自动关闭。没看到窗口？可能被浏览器拦下了，
        再点一次「重新打开登录窗口」。
      </p>

      <DialogFooter>
        <Button variant="outline" @click="logoutFromExpired()">退出</Button>
        <Button @click="startLogin()">
          {{ waiting ? "重新打开登录窗口" : "重新登录" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
