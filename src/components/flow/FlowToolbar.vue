<script setup lang="ts">
import { Hand, MousePointer2, Plus } from "lucide-vue-next"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useFlowEditor } from "@/composables/flow"

/**
 * 底部悬浮工具栏 —— 指针模式 + 画布内容的编辑动作。
 *
 * 加按钮就在这里加：拿 `useFlowEditor()` 里已有的动作接上即可，
 * 不用往编辑器根组件传 props。
 */
const { canvas } = useFlowEditor()
</script>

<template>
  <div
    class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
  >
    <Button
      :variant="canvas.interactionMode.value === 'select' ? 'secondary' : 'ghost'"
      size="icon"
      class="size-8 rounded-full"
      title="框选（左键拖拽拉框；按住空格可临时拖动画布）"
      @click="canvas.setInteractionMode('select')"
    >
      <MousePointer2 />
    </Button>
    <Button
      :variant="canvas.interactionMode.value === 'pan' ? 'secondary' : 'ghost'"
      size="icon"
      class="size-8 rounded-full"
      title="拖动画布（左键拖拽平移）"
      @click="canvas.setInteractionMode('pan')"
    >
      <Hand />
    </Button>

    <Separator
      orientation="vertical"
      class="mx-1 data-[orientation=vertical]:h-5"
    />

    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="添加节点"
      @click="canvas.addNode()"
    >
      <Plus />
    </Button>
  </div>
</template>
