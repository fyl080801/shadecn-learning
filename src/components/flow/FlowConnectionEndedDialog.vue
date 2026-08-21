<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 同步通道被**终局**掐掉时的提示：说清楚发生了什么，给一条出路。
 *
 * 提示**不可关闭**：关掉它只会留下一张看着正常、其实改了也不算数的画布 ——
 * 这正是这个弹窗存在的理由，普通断线反而什么都不用弹（会自动重试、改动会补发）。
 *
 * 管三种原因。第四种 `unauthorized` 由全站那只「会话过期」确认框接手
 * （同步层里调 `requestReLogin`）—— 它能在不离开这一页的前提下重新登录，
 * 比让人刷新更好，登录完通道就地恢复。
 */
const { sync } = useFlowEditor()
const router = useRouter()

const notices = {
  superseded: {
    title: "协作会话已过期",
    description:
      "这张画布已在你的另一个窗口打开，同一个人同时只能有一条协作连接，" +
      "所以这个窗口已经下线，此处的改动不会再同步给其他人。" +
      "刷新页面即可重新接管（离线期间的改动会自动补发）。",
    action: "刷新页面",
    run: () => window.location.reload()
  },
  forbidden: {
    title: "已失去这张画布的访问权限",
    description:
      "这张画布可能已被删除，或者你已不是它所属项目的成员 —— 通道已断开，" +
      "此处的改动不会再保存。如果这是误操作，请联系项目管理员重新邀请你。",
    action: "返回画布项目",
    run: () => void router.push("/projects")
  },
  /** 个人画布专属：协同那边超限是把房间锁成只读，不走这条路 */
  "too-large": {
    title: "画布太大，保存已停止",
    description:
      "这张画布的内容超出了单张画布的上限，最近的改动没能保存下来。" +
      "刷新页面会回到服务端存下的最后一版，删掉一些节点或连线之后就能继续保存。",
    action: "刷新页面",
    run: () => window.location.reload()
  }
} as const

const notice = computed(() => {
  const reason = sync.fatal.value
  // unauthorized 归全站的会话过期框管，这里不弹，免得两个模态叠在一起
  return reason && reason !== "unauthorized" ? notices[reason] : null
})
</script>

<template>
  <!-- 受控且不提供 @update:open：Esc、点遮罩都关不掉它 -->
  <AlertDialog :open="notice !== null">
    <AlertDialogContent
      v-if="notice"
      class="sm:max-w-md"
      @escape-key-down="(event: Event) => event.preventDefault()"
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{{ notice.title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ notice.description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogAction @click="notice.run()">{{ notice.action }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
