<script setup lang="ts">
import { computed, ref, watch } from "vue"
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
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 同步通道被**终局**掐掉时的提示：说清楚发生了什么，给一条出路。
 *
 * 默认**不可关闭**：关掉它只会留下一张看着正常、其实改了也不算数的画布 ——
 * 这正是这个弹窗存在的理由，普通断线反而什么都不用弹（会自动重试、改动会补发）。
 *
 * 管三种原因。第四种 `unauthorized` 由全站那只「会话过期」确认框接手
 * （同步层里调 `requestReLogin`）—— 它能在不离开这一页的前提下重新登录，
 * 比让人刷新更好，登录完通道就地恢复。
 *
 * **`too-large` 是唯一可关的一种，这是它的出路决定的**：另外两种，用户在这一页上
 * 再做什么都没有意义（连接不会回来）；而画布超限的自救办法恰恰是**在这一页上删东西** ——
 * 一个关不掉的模态会把唯一的出路挡死。删掉的内容进本地文档，刷新时和之前那些没送出去的
 * 改动一起提交，合并之后回到上限以内就恢复保存。
 */
const { sync, store } = useFlowEditor()
const router = useRouter()

const notices = {
  superseded: {
    title: "协作会话已过期",
    description:
      "这张画布已在你的另一个窗口打开，同一个人同时只能有一条协作连接，" +
      "所以这个窗口已经下线，此处的改动不会再同步给其他人。" +
      "刷新页面即可重新接管（离线期间的改动会自动补发）。",
    action: "刷新页面",
    dismissible: false,
    run: () => window.location.reload()
  },
  forbidden: {
    title: "已失去这张画布的访问权限",
    description:
      "这张画布可能已被删除，或者你已不是它所属项目的成员 —— 通道已断开，" +
      "此处的改动不会再保存。如果这是误操作，请联系项目管理员重新邀请你。",
    action: "返回画布项目",
    dismissible: false,
    run: () => void router.push("/projects")
  },
  /**
   * 两种画布共用：个人画布是推送被回了 413，项目画布是房间顶到硬限被锁写清场
   * （服务端的 4413 / `quota-exceeded`）。发生的是同一件事，出路也一样，所以文案只写一份。
   */
  "too-large": {
    title: "画布太大，改动已停止保存",
    description:
      "这张画布的内容超出了单张画布的上限，最近的改动没有保存到服务端，只留在这台设备上。" +
      "关掉这个提示，删掉一些节点或连线，再刷新页面 —— 删减会和之前的改动一起提交，" +
      "画布回到上限以内就恢复保存。",
    action: "刷新页面",
    dismissible: true,
    run: () => window.location.reload()
  }
} as const

/**
 * 个人画布的 `forbidden` 是**另一件事**：它没有项目、没有成员、没有管理员，能触发这条的
 * 只剩「这张画布已经没了」（推送被回 404，多半是在另一个窗口里删的）。
 *
 * 所以文案和落点都得换。落点尤其不能照抄：离开画布回哪儿**认 `mode` 不认 `projectId`**
 * （REQ-SOLO）—— 个人空间在库里确实是个项目，但把人送进「画布项目」列表，
 * 他会在那儿找不到自己刚才那张画布。
 */
const soloForbidden = {
  title: "这张画布已经不在了",
  description:
    "它可能是在你的另一个窗口里被删掉的 —— 通道已断开，此处的改动不会再保存。",
  action: "返回个人画布",
  dismissible: false,
  run: () => void router.push("/personal")
} as const

const notice = computed(() => {
  const reason = sync.fatal.value
  // unauthorized 归全站的会话过期框管，这里不弹，免得两个模态叠在一起
  if (!reason || reason === "unauthorized") return null
  if (reason === "forbidden" && store.meta?.mode === "solo") return soloForbidden
  return notices[reason]
})

/** 只对可关的那种有意义。换了一种原因就重新弹：上一次的「知道了」不该把新情况也盖掉 */
const dismissed = ref(false)
watch(
  () => sync.fatal.value,
  () => {
    dismissed.value = false
  }
)

const open = computed(() => notice.value !== null && !dismissed.value)

/** Esc：可关的那种当作「知道了」。受控且没绑 @update:open，所以这一下得自己落 */
function onEscape(event: Event) {
  if (notice.value?.dismissible) dismissed.value = true
  else event.preventDefault()
}
</script>

<template>
  <!-- 受控且不提供 @update:open：关不关得掉只由下面这两个按钮决定，点遮罩一律不关 -->
  <AlertDialog :open="open">
    <AlertDialogContent v-if="notice" class="sm:max-w-md" @escape-key-down="onEscape">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ notice.title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ notice.description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button v-if="notice.dismissible" variant="outline" @click="dismissed = true">
          知道了，先去删内容
        </Button>
        <AlertDialogAction @click="notice.run()">{{ notice.action }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
