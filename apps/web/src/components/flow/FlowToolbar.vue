<script setup lang="ts">
import { Hand, MousePointer2, Plus } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { ADDABLE_NODE_TYPES } from "@/components/flow/node-types"
import FlowAgentQuickPrompt from "@/components/flow/agent/FlowAgentQuickPrompt.vue"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 底部悬浮工具栏 —— 指针模式 + 画布内容的编辑动作。撤销 / 重做只走快捷键。
 *
 * 胶囊右侧另挂一枚独立的深色圆钮：agent 快捷输入（`FlowAgentQuickPrompt`，输完直接开新会话执行）。
 * 它不在胶囊里，也不参与居中 —— 居中的始终是胶囊本身，圆钮贴在它右边。
 *
 * 加按钮就在这里加：拿 `useFlowEditor()` 里已有的动作接上即可，
 * 不用往编辑器根组件传 props。
 *
 * **新增节点只有一枚加号**，不按注册表铺一排图标：类型会越加越多，
 * 一整排图标既认不出来也放不下。点加号弹出类型菜单（`ADDABLE_NODE_TYPES`），
 * 选哪种建哪种，菜单项的名字和图标都来自注册表。
 *
 * 「添加分组」也不在这里 —— 分组是**把已经选中的一片节点圈起来**，
 * 凭空建一个空框再把节点拖进去是反的。入口在框选后浮出的选区工具栏
 * （`FlowSelectionToolbar`）。
 */
const { canvas } = useFlowEditor()
</script>

<template>
  <div class="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
    <div class="flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="canvas.interactionMode.value === 'select' ? 'secondary' : 'ghost'"
            size="icon"
            class="size-8 rounded-full"
            aria-label="框选"
            @click="canvas.setInteractionMode('select')"
          >
            <MousePointer2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">框选（左键拖拽拉框；按住空格可临时拖动画布）</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="canvas.interactionMode.value === 'pan' ? 'secondary' : 'ghost'"
            size="icon"
            class="size-8 rounded-full"
            aria-label="拖动画布"
            @click="canvas.setInteractionMode('pan')"
          >
            <Hand />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">拖动画布（左键拖拽平移）</TooltipContent>
      </Tooltip>

      <Separator
        orientation="vertical"
        class="mx-1 data-[orientation=vertical]:h-5"
      />

      <!-- 吸附（网格 + 辅助线）没有开关：始终生效，见 useFlowSnapping -->
      <!--
        Tooltip 必须在最外层、菜单整个放进它触发器的 span 里：reka-ui 的触发器就近找外层浮层登记锚点，
        要是 DropdownMenu 套在 Tooltip 外面，菜单触发器会登记到 Tooltip 上，菜单没锚点、被定位到屏幕外。
      -->
      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-8 rounded-full data-[state=open]:bg-accent"
                  aria-label="添加节点"
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="center"
                :side-offset="12"
                class="w-44"
              >
                <DropdownMenuItem
                  v-for="def in ADDABLE_NODE_TYPES"
                  :key="def.type"
                  @select="canvas.addNode(def.type)"
                >
                  <component :is="def.icon" />
                  {{ def.label }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">添加节点</TooltipContent>
      </Tooltip>
    </div>

    <div class="absolute left-full top-1/2 ml-3 -translate-y-1/2">
      <FlowAgentQuickPrompt />
    </div>
  </div>
</template>
