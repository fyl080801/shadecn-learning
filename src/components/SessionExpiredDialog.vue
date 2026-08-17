<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
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
import {
  embeddedLoginUrl,
  finishReLogin,
  isEmbeddedLoginDone,
  useAuth
} from "@/lib/auth"

/**
 * 会话过期的全局提示。跟 Toaster 一样在 App.vue 里挂一次：
 * 任何一个接口拿到 401 都会打开它（见 lib/auth.ts 的 apiFetch / requestReLogin）。
 *
 * 两层，都可以直接关掉、什么都不做（页面和没提交的内容原样保留）：
 *   第一层：退出 / 重新登录；
 *   第二层：模态窗里用 iframe 走一遍完整的 OIDC，登录成功就自己关掉，人留在原页。
 *
 * 登录成功怎么知道？两条腿：
 *   - 服务端那张 /auth/embedded-done 落地页 postMessage 过来（快）；
 *   - 每 3 秒问一次 /api/auth/me（兜底：消息被拦、或用户是在新窗口里登的）。
 * 会话是 httpOnly cookie，前端只能这么确认。
 */
const { sessionExpired, dismissReLogin, logoutFromExpired } = useAuth()

/** 第二层：内嵌登录模态 */
const embedded = ref(false)
/** iframe 每次打开都换一个 key，重开时重新走一遍登录，而不是留着上一次的页面 */
const frameKey = ref(0)
const frameSrc = computed(() => embeddedLoginUrl())

function openEmbedded() {
  frameKey.value += 1
  embedded.value = true
}

/** 关掉第一层（Esc / 点遮罩 / 右上角 ×）：什么都不做。
 *  「去开第二层」也会让第一层关上，那不算用户放弃，所以要放过 */
function onAskOpenChange(open: boolean) {
  if (!open && !embedded.value) dismissReLogin()
}

/** 关掉内嵌登录（Esc / 点遮罩 / 右上角 ×）：什么都不做，连第一层一起收起来 */
function closeEmbedded() {
  embedded.value = false
  dismissReLogin()
}

/** Keycloak 不让被嵌进 iframe 时的退路：另开一个窗口登，登完同样会通知回来 */
function openLoginWindow() {
  window.open(embeddedLoginUrl(), "app-relogin", "width=520,height=680")
}

/** 真的登上了才收工；没登上（比如登录失败停在错误页）就让窗口开着 */
async function settle() {
  if (!(await finishReLogin())) return
  embedded.value = false
  toast.success("已重新登录")
}

function onMessage(event: MessageEvent) {
  if (!isEmbeddedLoginDone(event)) return
  void settle()
}

// 轮询只在模态开着的时候跑：关掉就停，免得白白发请求
const poll = useIntervalFn(() => void settle(), 3000, { immediate: false })

watch(embedded, (open) => {
  if (open) {
    window.addEventListener("message", onMessage)
    poll.resume()
  } else {
    window.removeEventListener("message", onMessage)
    poll.pause()
  }
})

// 第一层被关掉时（比如别处直接调了 dismiss），第二层不该还留着
watch(sessionExpired, (expired) => {
  if (!expired) embedded.value = false
})

onBeforeUnmount(() => window.removeEventListener("message", onMessage))
</script>

<template>
  <!-- 第一层：退出 / 重新登录，关掉就什么都不做 -->
  <Dialog :open="sessionExpired && !embedded" @update:open="onAskOpenChange">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>登录状态已失效</DialogTitle>
        <DialogDescription>
          你的登录状态已经过期，后端不再受理请求。可以就地重新登录（页面和没提交的
          内容都还在），也可以退出到登录页；直接关掉这个窗口则什么都不做。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="logoutFromExpired()">退出</Button>
        <Button @click="openEmbedded()">重新登录</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 第二层：模态窗里就地登录，登完自动关，人不离开当前页 -->
  <Dialog :open="embedded" @update:open="(open) => !open && closeEmbedded()">
    <DialogContent class="gap-3 sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>重新登录</DialogTitle>
        <DialogDescription>
          在下面登录完成后这个窗口会自动关闭，页面留在原处。
        </DialogDescription>
      </DialogHeader>

      <iframe
        :key="frameKey"
        :src="frameSrc"
        title="重新登录"
        class="h-[420px] w-full rounded-md border bg-background"
      />

      <p class="text-muted-foreground text-xs">
        下面没有显示登录页面？多半是 Keycloak 不允许被嵌入，
        <button
          type="button"
          class="text-foreground underline underline-offset-4"
          @click="openLoginWindow()"
        >
          在新窗口登录
        </button>
        —— 登完回到这里同样会自动关闭。
      </p>
    </DialogContent>
  </Dialog>
</template>
