<script setup lang="ts">
import { computed } from "vue"
import { type NodeProps } from "@vue-flow/core"
import { NodeResizer } from "@vue-flow/node-resizer"
import { Ungroup } from "lucide-vue-next"

import FlowNodeChrome from "@/components/flow/FlowNodeChrome.vue"
import { GROUP_DEFAULT_BACKGROUND } from "@/components/flow/node-constants"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 分组框 —— 把一片节点圈在一起的背景板。
 *
 * 它和普通节点除了都是节点之外没有任何共同点：有固定尺寸、可以拉伸、
 * 压在所有节点之下（`GROUP_Z_INDEX`）、而且**不挡住画布**。这正是节点类型注册表
 * 要证明的事 —— 形状完全不同的节点能共存，加一种不用动任何既有代码。
 *
 * 但**外壳和普通节点是同一套**（`FlowNodeChrome`）：名字贴在框外的左上角、
 * 双击改名、选中时工具栏浮在正上方居中。分组的名字曾经长在框**内部**的标题栏上，
 * 那让它看着像另一种东西 —— 画布上「这块叫什么」应该只有一种表达方式。
 * 分组只是把工具栏那排按钮换成了自己的（没有「复制」）。
 *
 * 「把节点拖进已有分组」（自动 reparent）还没做：数据上 `parentNode` / `extent` 是通的
 * （`flow-doc.ts` 两侧都读写它们，Vue Flow 也认），缺的只是拖动时的命中判定。
 */
const props = defineProps<NodeProps<Record<string, unknown>>>()

const { canvas, store } = useFlowEditor()

/** 拉伸手柄的最小尺寸：再小就装不下一个节点，分组也就没意义了 */
const MIN_SIZE = { width: 160, height: 120 }

/** 顶部拖动把手的高度，同时也是「名字下面那条」的视觉厚度 */
const HANDLE_HEIGHT = 24

const background = computed(() =>
  typeof props.data.background === "string" ? props.data.background : GROUP_DEFAULT_BACKGROUND
)

const label = computed(() => (typeof props.data.label === "string" ? props.data.label : "分组"))

/**
 * 拉伸结束才写进文档。
 *
 * 拉伸过程中每一帧都会触发，中间态和拖动位置一样不该进 Y.Doc ——
 * 一次拉伸会变成几十条更新，而且每一条都会广播出去。
 */
function onResizeEnd(event: { params: { x: number; y: number; width: number; height: number } }) {
  const { x, y, width, height } = event.params
  store.separateUndo()
  store.resizeNode(props.id, { width, height, x, y }, "调整分组大小")
  store.separateUndo()
}
</script>

<template>
  <!--
    整块 pointer-events-none，只有顶部把手和拉伸手柄可点。

    分组是一大片背景板，如果它照单全收鼠标事件，框选、平移这些**画布**的操作
    在分组范围内就全废了 —— 想框选组里的几个节点，结果拖出来的是整个分组。
    所以：点内部空白穿透到画布，拖顶部那条才是拖分组。
  -->
  <div
    class="pointer-events-none relative h-full w-full rounded-lg border-2 border-dashed transition-colors"
    :class="selected ? 'border-primary/70' : 'border-muted-foreground/30'"
    :style="{ backgroundColor: background }"
  >
    <!--
      拉伸手柄由官方 NodeResizer 提供 —— 它自己处理缩放下的坐标换算，
      手写 absolute + transform 在缩放时必歪（见 CLAUDE.md 的画布约定）。
      只在选中时出现，否则画布上每个分组都挂着八个点。
      （它的手柄要从上面那层 pointer-events-none 里把事件要回来，
      规则在 src/styles/vue-flow.css。）
    -->
    <NodeResizer
      :is-visible="selected"
      :min-width="MIN_SIZE.width"
      :min-height="MIN_SIZE.height"
      @resize-end="onResizeEnd"
    />

    <!--
      顶部把手：**分组唯一可拖动的地方**。

      名字已经挪到框外（FlowNodeChrome），但拖动不能跟着挪过去 ——
      NodeToolbar 是 teleport 到画布容器上的，在它上面按下鼠标不会变成拖节点。
      所以这里留一条贴着名字下方的把手，正是原来标题栏所在的位置：
      平时不画出来（分组是背景板，不该有一条常驻的横杠），指上去才浮出底色。
    -->
    <div
      class="pointer-events-auto absolute inset-x-0 top-0 cursor-move rounded-t-md transition-colors hover:bg-muted-foreground/10"
      :style="{ height: `${HANDLE_HEIGHT}px` }"
      title="拖这里移动整个分组"
    />

    <FlowNodeChrome :node-id="props.id" :label="label">
      <template #actions>
        <!--
          **解组**，不是删除：拆掉的只有这个框，组里的节点原地留下
          （`store.removeElements` 会把它们的 parentNode 解掉、坐标换算回画布坐标）。
          所以既不用垃圾桶图标也不用 destructive 那身红 —— 那两样都在说「东西要没了」，
          而这一下什么都没丢，撤销一次还能原样回来。
        -->
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full"
          title="解组（拆掉分组框，组内节点保留）"
          @click.stop="canvas.deleteNode(props.id)"
        >
          <Ungroup />
        </Button>
      </template>
    </FlowNodeChrome>
  </div>
</template>
