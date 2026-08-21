<script setup lang="ts">
import { Hand, MousePointer2, Plus } from "lucide-vue-next"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { NEW_NODE_TYPE } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow"

/**
 * 底部悬浮工具栏 —— 指针模式 + 画布内容的编辑动作。
 *
 * 加按钮就在这里加：拿 `useFlowEditor()` 里已有的动作接上即可，
 * 不用往编辑器根组件传 props。
 *
 * **新增节点只有一枚加号**，不再按注册表铺一排图标：类型会越加越多，
 * 一整排图标既认不出来也放不下。加什么由 `NEW_NODE_TYPE` 说了算（当前是文本节点）。
 *
 * 「添加分组」也不在这里 —— 分组是**把已经选中的一片节点圈起来**，
 * 凭空建一个空框再把节点拖进去是反的。入口在框选后浮出的选区工具栏
 * （`FlowSelectionToolbar`）。
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

    <!-- 吸附（网格 + 辅助线）没有开关：始终生效，见 useFlowSnapping -->
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="添加节点"
      @click="canvas.addNode(NEW_NODE_TYPE)"
    >
      <Plus />
    </Button>
  </div>
</template>
