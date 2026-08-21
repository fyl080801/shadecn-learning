<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { Position, type NodeProps } from "@vue-flow/core"
import { NodeResizer } from "@vue-flow/node-resizer"
import { NodeToolbar } from "@vue-flow/node-toolbar"
import { Trash2 } from "lucide-vue-next"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { GROUP_DEFAULT_BACKGROUND } from "@/components/flow/node-types"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow"

/**
 * 分组框 —— 把一片节点圈在一起的背景板。
 *
 * 它和 `ProcessNode` 除了都是节点之外没有任何共同点：有固定尺寸、可以拉伸、
 * 压在所有节点之下（`GROUP_Z_INDEX`）、而且**不挡住画布**。这正是节点类型注册表
 * 要证明的事 —— 形状完全不同的节点能共存，加一种不用动任何既有代码。
 *
 * 「把节点拖进分组」（自动 reparent）还没做：数据上 `parentNode` / `extent` 是通的
 * （`flow-doc.ts` 两侧都读写它们，Vue Flow 也认），缺的只是拖动时的命中判定。
 */
const props = defineProps<NodeProps<Record<string, unknown>>>()

const { canvas, presence, selection, store } = useFlowEditor()

/** 拉伸手柄的最小尺寸：再小就装不下一个节点，分组也就没意义了 */
const MIN_SIZE = { width: 160, height: 120 }

const background = computed(() =>
  typeof props.data.background === "string" ? props.data.background : GROUP_DEFAULT_BACKGROUND
)

const label = computed(() => (typeof props.data.label === "string" ? props.data.label : "分组"))

/** 只在「当前单独选中的就是它」时露出操作栏，理由同 ProcessNode */
const showToolbar = computed(() => selection.selectedNodeId.value === props.id)

const occupants = computed(() => presence.occupantsOf("node", props.id))

// —— 就地改名 ——

const editing = ref(false)
const draft = ref("")
const inputRef = ref<HTMLInputElement | null>(null)

async function startEdit() {
  canvas.selectOnly(props.id)
  draft.value = label.value
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

function commitEdit() {
  if (!editing.value) return
  editing.value = false

  const next = draft.value.trim()
  if (!next || next === label.value) return

  store.separateUndo()
  store.updateNodeData(props.id, { label: next }, "修改分组名")
  store.separateUndo()
}

function cancelEdit() {
  editing.value = false
}

/**
 * 拉伸结束才写进文档。
 *
 * 拉伸过程中每一帧都会触发，中间态和拖动位置一样不该进 Y.Doc ——
 * 一次拉伸会变成几十条更新和几十行审计记录，而且每一条都会广播出去。
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
    整块 pointer-events-none，只有标题栏和拉伸手柄可点。

    分组是一大片背景板，如果它照单全收鼠标事件，框选、平移这些**画布**的操作
    在分组范围内就全废了 —— 想框选组里的几个节点，结果拖出来的是整个分组。
    所以：点内部空白穿透到画布，拖标题栏才是拖分组。
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
    -->
    <NodeResizer
      :is-visible="selected"
      :min-width="MIN_SIZE.width"
      :min-height="MIN_SIZE.height"
      @resize-end="onResizeEnd"
    />

    <!-- 标题栏：分组唯一可拖动的地方 -->
    <div class="pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 px-2 py-1.5">
      <input
        v-if="editing"
        ref="inputRef"
        v-model="draft"
        class="nodrag nopan h-5 w-32 rounded border border-primary bg-card px-1 text-xs outline-none"
        @blur="commitEdit"
        @keydown.enter.prevent="commitEdit"
        @keydown.esc.prevent="cancelEdit"
        @dblclick.stop
      />
      <span
        v-else
        class="cursor-text rounded px-1 text-xs font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground"
        title="双击改名（拖动这里移动整个分组）"
        @dblclick.stop="startEdit"
      >
        {{ label }}
      </span>

      <span
        v-for="peer in occupants"
        :key="peer.clientId"
        class="flex items-center gap-1 rounded-full py-[2px] pl-[2px] pr-1.5 text-[10px] font-medium leading-none text-white shadow-sm"
        :style="{ backgroundColor: peer.user.color }"
      >
        <FlowPresenceAvatar :user="peer.user" class="size-3.5" />
        {{ peer.user.name }}
      </span>
    </div>

    <NodeToolbar :is-visible="showToolbar" :position="Position.Top" align="end">
      <div
        class="nodrag nopan pointer-events-auto flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
      >
        <!-- 删分组只删这个框，组里的节点留在原地 —— 见 useFlowCanvas.deleteNode -->
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          title="删除分组（组内节点保留）"
          @click.stop="canvas.deleteNode(id)"
        >
          <Trash2 />
        </Button>
      </div>
    </NodeToolbar>
  </div>
</template>
