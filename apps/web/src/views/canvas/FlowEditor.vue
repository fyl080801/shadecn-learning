<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { Panel } from "@vue-flow/core"
import { Button } from "@/components/ui/button"

import FlowCanvas from "@/components/flow/FlowCanvas.vue"
import FlowAgentChat from "@/components/flow/agent/FlowAgentChat.vue"
import FlowConnectionEndedDialog from "@/components/flow/FlowConnectionEndedDialog.vue"
import FlowDirectorOverlay from "@/components/flow/FlowDirectorOverlay.vue"
import FlowGrowMenu from "@/components/flow/FlowGrowMenu.vue"
import FlowPresenceBar from "@/components/flow/FlowPresenceBar.vue"
import FlowShareButton from "@/components/flow/FlowShareButton.vue"
import FlowTitleCapsule from "@/components/flow/FlowTitleCapsule.vue"
import FlowToolbar from "@/components/flow/FlowToolbar.vue"
import { provideFlowEditor, useFlowShortcuts } from "@/composables/flow"
import { provideFlowAgentPanel } from "@/composables/flow/agent-panel"

/**
 * 画布编辑器 —— 独占整屏（路由挂在 BlankLayout 模板页下，没有侧栏）。
 *
 * 这个文件只做两件事：**建上下文**、**摆组件**。
 * 具体功能在 `@/composables/flow`（状态与动作）和 `@/components/flow`（界面）里，
 * 加一块新面板不需要动这里，拿 `useFlowEditor()` 自己接上下文就行。
 */

const props = defineProps<{ flowId: string }>()
const router = useRouter()

const editor = provideFlowEditor(props)
useFlowShortcuts(editor)
// 右上角对话框和工具栏快捷输入共用的那一份 agent（docs/20）；任务列表经 `editor.sync` 的 stateless 推送更新
provideFlowAgentPanel(editor)

const { sync, document: doc } = editor

/**
 * 内容来自 Y.Doc，所以「能不能开始画」不只看元信息拿到没有。
 *
 * 两条路任一成立即可：
 * - **服务端同步完成** —— 内容保证是最新的，正常情况走这条；
 * - **本地缓存里有东西** —— 断网时走这条，先把上次看到的画出来（离线可用）。
 *
 * 「本地缓存加载完了但里面是空的」不算 —— 那既可能是这张画布本来就空，
 * 也可能是我从没打开过它而此刻又断着网。这时候继续显示加载中，
 * 比甩一张空画布让人以为内容丢了要好。
 *
 * 两种画布共用这一段：个人画布的「同步完成」是拉完了那一次 HTTP，
 * 项目画布的是 WebSocket 首次同步 —— 判据一样，通道不同。
 */
const ready = computed(() => {
  if (doc.loading.value) return false
  const session = sync.session.value
  if (!session) return false
  return session.synced.value || (session.cached.value && session.hasContent.value)
})
</script>

<template>
  <div class="relative h-full w-full">
    <div
      v-if="doc.loadError.value"
      class="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <p class="text-sm text-destructive">{{ doc.loadError.value }}</p>
      <Button variant="outline" size="sm" @click="router.push('/canvas')">返回工作区</Button>
    </div>

    <div
      v-else-if="!ready"
      class="flex h-full items-center justify-center text-muted-foreground"
    >
      正在加载画布…
    </div>

    <template v-else>
      <!-- 右上角一排：分享 + agent 对话，用 Vue Flow 的 <Panel> 定位，所以放进 VueFlow 的插槽里；定位只写在这一层 -->
      <FlowCanvas>
        <Panel position="top-right" class="flex items-start gap-2">
          <FlowShareButton />
          <FlowAgentChat />
        </Panel>
      </FlowCanvas>

      <!-- 左上角一排：标题胶囊 + 在场头像栏。定位只写在这一层，两枚胶囊各自不管位置 -->
      <div class="absolute left-4 top-4 z-10 flex items-center gap-2">
        <FlowTitleCapsule />
        <FlowPresenceBar />
      </div>

      <FlowToolbar />
      <!-- 点出口加号 / 拉线到空白处弹出的候选类型菜单；位置由 reka-ui 按参照元素算，放哪一层都行 -->
      <FlowGrowMenu />
      <!-- 导演台节点「打开导演台」后的全屏导演台；关着不挂，开着 teleport 到 body，层级说明在组件里 -->
      <FlowDirectorOverlay />
    </template>

    <!-- 放在加载分支之外：连接被终结跟画布加载到哪一步无关，任何时候都得盖住整屏 -->
    <FlowConnectionEndedDialog />
  </div>
</template>
