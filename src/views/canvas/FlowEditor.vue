<script setup lang="ts">
import { useRouter } from "vue-router"
import { Button } from "@/components/ui/button"

import FlowCanvas from "@/components/flow/FlowCanvas.vue"
import FlowNodeInspector from "@/components/flow/FlowNodeInspector.vue"
import FlowTitleCapsule from "@/components/flow/FlowTitleCapsule.vue"
import FlowToolbar from "@/components/flow/FlowToolbar.vue"
import { provideFlowEditor, useFlowShortcuts } from "@/composables/flow"

/**
 * 画布编辑器 —— 独占整屏（路由 meta.layout = 'bare'，App.vue 不渲染侧栏）。
 *
 * 这个文件只做两件事：**建上下文**、**摆组件**。
 * 具体功能在 `@/composables/flow`（状态与动作）和 `@/components/flow`（界面）里，
 * 加一块新面板不需要动这里，拿 `useFlowEditor()` 自己接上下文就行。
 */

const props = defineProps<{ flowId: string }>()
const router = useRouter()

const editor = provideFlowEditor(props)
useFlowShortcuts(editor)

const { document: doc } = editor
</script>

<template>
  <div class="relative h-full w-full">
    <div
      v-if="doc.loading.value"
      class="flex h-full items-center justify-center text-muted-foreground"
    >
      正在加载画布…
    </div>

    <div
      v-else-if="doc.loadError.value"
      class="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <p class="text-sm text-destructive">{{ doc.loadError.value }}</p>
      <Button variant="outline" size="sm" @click="router.push('/projects')">返回项目列表</Button>
    </div>

    <template v-else>
      <FlowCanvas />
      <FlowTitleCapsule />
      <FlowToolbar />
      <FlowNodeInspector />
    </template>
  </div>
</template>
