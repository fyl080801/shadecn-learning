<script lang="ts">
import { ref as moduleRef } from "vue"

/** 预览开关：模块级，同一页里各次打开共用（刷新回到默认） */
const showPreview = moduleRef(true)
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { Eye, EyeOff } from "@lucide/vue"

import { useNodePopupActions } from "@/components/flow/popup/node-popup"
import TextMarkdown from "@/components/flow/TextMarkdown.vue"
import { Button } from "@/components/ui/button"
import { useFlowNode } from "@/composables/flow/useFlowNode"
import { useFlowStore } from "@/stores/flow"

/**
 * 文本节点的弹出编辑内容（`popup/popups.ts` 的 `text`，docs/13 §3.7）：左边编辑 Markdown 原文，右边实时预览
 * （窄屏上下排）。外框、标题栏、遮罩、Esc / 点遮罩关闭都是宿主 `FlowNodePopupHost` 的事。
 *
 * 标题栏里一枚「预览」开关（teleport 进宿主给的按钮位）：关掉后编辑区占满整块。开关状态记在模块里，
 * 这一页里下次打开文本编辑还是上次的样子；刷新回到默认（开）。
 *
 * 正文和就地编辑是同一个字段、同一套草稿（`useFlowNode().draft("data", "text")`：草稿接管画面、只在结束时写一次、
 * 前后夹 `separateUndo`）—— 一次弹出编辑 = 一条撤销。**关闭 = 卸载 = 提交**（点「完成」、Esc、点遮罩都一样），
 * 不另设「取消」：误改了用撤销。节点已经被删了（宿主因此收起）就不提交。
 *
 * 不 trim、允许清空：把一段文字删光是一次正当的编辑（同 `TextBody`）。
 */
const props = defineProps<{ nodeId: string; payload?: unknown }>()
// 宿主约定的 close（这里不主动关；声明上，免得多根组件把 onClose 当成透传属性报警告）
defineEmits<{ close: [] }>()

const store = useFlowStore()
const node = useFlowNode(() => props.nodeId)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const actions = useNodePopupActions()
const preview = showPreview

function togglePreview() {
  preview.value = !preview.value
  // 焦点留在编辑区：开关只是换个看法，不该打断正在写的字
  inputRef.value?.focus()
}

const body = node.draft<string>("data", "text", {
  read: (raw) => (typeof raw === "string" ? raw : ""),
  fallback: "",
  label: "修改文本",
  focus: () => {
    inputRef.value?.focus()
    // 光标落到末尾，接着往下写
    const end = inputRef.value?.value.length ?? 0
    inputRef.value?.setSelectionRange(end, end)
  }
})

onMounted(() => void body.start())
onBeforeUnmount(() => {
  if (store.nodeById.has(props.nodeId)) body.commit()
  else body.cancel()
})
</script>

<template>
  <Teleport v-if="actions" :to="actions">
    <Button
      size="sm"
      variant="ghost"
      :aria-pressed="preview"
      :title="preview ? '隐藏预览' : '显示预览'"
      data-testid="text-editor-preview-toggle"
      @mousedown.prevent
      @click="togglePreview()"
    >
      <Eye v-if="preview" />
      <EyeOff v-else />
      预览
    </Button>
  </Teleport>
  <div
    class="grid h-full"
    :class="preview ? 'grid-rows-2 md:grid-cols-2 md:grid-rows-1' : 'grid-rows-1'"
    data-testid="text-editor"
  >
    <textarea
      ref="inputRef"
      v-model="body.draft.value"
      class="h-full w-full resize-none border-0 bg-background p-4 font-mono text-sm leading-relaxed outline-none"
      :class="preview ? 'border-b md:border-b-0 md:border-r' : ''"
      placeholder="用 Markdown 写正文：# 标题、**加粗**、- 列表、`代码`……"
      aria-label="正文（Markdown）"
      data-testid="text-editor-input"
    />
    <div v-if="preview" class="h-full overflow-auto p-4" data-testid="text-editor-preview">
      <TextMarkdown v-if="body.draft.value.trim()" :text="body.draft.value" />
      <p v-else class="text-sm text-muted-foreground">预览会显示在这里</p>
    </div>
  </div>
</template>
