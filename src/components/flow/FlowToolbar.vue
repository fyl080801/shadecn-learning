<script setup lang="ts">
import { Plus, Trash2 } from "lucide-vue-next"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow"

/**
 * 底部悬浮工具栏 —— 画布内容的编辑动作。
 *
 * 加按钮就在这里加：拿 `useFlowEditor()` 里已有的动作接上即可，
 * 不用往编辑器根组件传 props。
 */
const { canvas, selection } = useFlowEditor()
</script>

<template>
  <div
    class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-card/95 p-1.5 shadow-lg backdrop-blur"
  >
    <Button variant="ghost" size="sm" @click="canvas.addNode()">
      <Plus />
      添加节点
    </Button>
    <Button
      variant="ghost"
      size="sm"
      :disabled="!selection.selectedNode.value"
      @click="selection.deleteSelection()"
    >
      <Trash2 />
      删除选中
    </Button>
  </div>
</template>
