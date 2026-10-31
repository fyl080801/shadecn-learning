<script setup lang="ts">
import { ArrowUp } from "@lucide/vue"

import { Button } from "@/components/ui/button"

/**
 * 发送按钮 —— 画布上**所有**写字发出去的输入区共用这一枚：agent 对话框（`FlowAgentComposer`）、节点的底部输入框
 * （`PromptComposer`）。圆形图标按钮、里面一个 ↑，长相只在这里改一处。
 *
 * 只管长相和点击；能不能点（`disabled`）、点了做什么由用它的一方决定。
 */
defineProps<{ disabled?: boolean }>()

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <Button
    size="icon-sm"
    class="shrink-0 rounded-full"
    :disabled="disabled"
    aria-label="发送"
    title="发送"
    @click="emit('click')"
  >
    <ArrowUp class="size-4" />
  </Button>
</template>
