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
import { useFlowEditor } from "@/composables/flow"

/**
 * 协同连接被服务端**终局**关掉时的提示：说清楚发生了什么，给一条出路。
 *
 * 提示**不可关闭**：关掉它只会留下一张看着正常、其实改了也不算数的画布 ——
 * 这正是这个弹窗存在的理由，普通断线反而什么都不用弹（会自动重连、改动会补发）。
 *
 * 只管两种原因。第三种 `unauthorized` 由全站那只「会话过期」确认框接手
 * （`useFlowCollab` 里调 `requestReLogin`）—— 它能在不离开这一页的前提下重新登录，
 * 比让人刷新更好，登录完连接就地恢复。
 */
const { collab } = useFlowEditor()
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
      "你已不是这个项目的成员，协作连接已断开，此处的改动不会再同步给其他人。" +
      "如果这是误操作，请联系项目管理员重新邀请你。",
    action: "返回画布项目",
    run: () => void router.push("/projects")
  }
} as const

const notice = computed(() => {
  const reason = collab.fatal.value
  // unauthorized 归全站的会话过期框管，这里不弹，免得两个模态叠在一起
  return reason === "superseded" || reason === "forbidden" ? notices[reason] : null
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
