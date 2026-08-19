<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { Handle, Position, type NodeProps } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"
import { Copy, Trash2 } from "lucide-vue-next"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow"

export interface ProcessNodeData {
  label: string
}

const props = defineProps<NodeProps<ProcessNodeData>>()

/** 名字那一行贴节点上边的距离 */
const LABEL_OFFSET = 4

/**
 * 操作栏贴节点上边的距离 = 名字行的偏移 + 名字行自身的高度 + 一点间距。
 *
 * 两块是各自独立定位的（NodeToolbar 各管各的），没有文档流会把它们推开 ——
 * 所以「堆叠」是靠这个偏移量算出来的，名字行的高度变了就得跟着调。
 */
const TOOLBAR_OFFSET = LABEL_OFFSET + 20 + 6

const { canvas, presence, selection, store } = useFlowEditor()

/**
 * 节点工具栏什么时候露出来。
 *
 * 两个选中态都认：Vue Flow 自己的 `selected`（框选、点选都会置上），
 * 以及我们自己那份给属性面板用的 `selection` —— 免得某一路没同步上时按钮不出现。
 */
const showToolbar = computed(
  () => props.selected || selection.selectedNodeId.value === props.id
)

/**
 * 谁正在动这个节点（远端）。
 *
 * **只是提示，不是限制** —— 谁都可以同时改同一个节点，CRDT 负责合并：
 * 改不同字段各自保留，改同一字段则收敛到同一个结果。
 * 「一个人在编辑时别人不能碰」那套占用规则已经从画布上摘掉了，
 * 仲裁逻辑本身还留在 `src/lib/presence.ts`（有测试），要恢复只需重新接线。
 */
const occupants = computed(() => presence.occupantsOf("node", props.id))

// —— 就地改标题 ——

const editing = ref(false)
const draft = ref("")
const inputRef = ref<HTMLInputElement | null>(null)

/**
 * 双击标题就地改名。
 *
 * 先 `select(id)`：一来属性面板要跟着走，二来选中会上报到 awareness，
 * 别人就能看到「有人在动这个节点」。
 */
async function startEdit() {
  selection.select(props.id)
  draft.value = props.data.label
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

/**
 * 提交改名。走 store 而不是直接改 `data` —— 这样它才进撤销栈、才同步给别人、
 * 才被服务端落库（数据层的铁律）。名字没变或被清空就当没改过。
 */
function commitEdit() {
  if (!editing.value) return
  editing.value = false

  const next = draft.value.trim()
  if (!next || next === props.data.label) return

  // 改标题是一次独立的操作，别和刚才的拖动之类并进同一条撤销
  store.separateUndo()
  store.updateNodeData(props.id, { label: next }, "修改节点标题")
  store.separateUndo()
}

function cancelEdit() {
  editing.value = false
}
</script>

<template>
  <!--
    宽度固定 360，高度下限按 16:9 给到 202.5（= 360 × 9 / 16），内容更高就自然撑开。
    写成 `min-h` 而不是 `aspect-video`：aspect-ratio 只在高度自动、且内容装得下时才成立，
    内容一旦超出，块级盒子是溢出而不是长高 —— 那正好和「内容高就撑开」相反。
  -->
  <div
    class="relative w-[360px] min-h-[202.5px] rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
  >
    <!--
      节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
      （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
      is-visible 常开，否则默认只在节点被选中时出现。
    -->
    <NodeToolbar :is-visible="true" :position="Position.Top" align="start" :offset="LABEL_OFFSET">
      <div class="flex items-center gap-1.5">
        <!-- nodrag / nopan：在输入框里拖选文字不该变成拖节点或拖画布 -->
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
          class="cursor-text text-xs font-medium text-muted-foreground hover:text-foreground"
          title="双击改名"
          @dblclick.stop="startEdit"
        >
          {{ data.label }}
        </span>

        <!-- 谁在动它就贴谁的头像 + 名字（纯提示），颜色和那个人的光标一致 -->
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
    </NodeToolbar>

    <!--
      选中时才出现的操作栏：**堆在名字那一行的上面**，水平居中对齐节点。
      样式照搬底部的 FlowToolbar（圆角胶囊 + 半透明卡片底 + backdrop-blur + size-8 圆按钮），
      画布上的浮动工具栏就该长一个样。

      定位仍旧交给 NodeToolbar：`align=center` 负责水平居中，
      `offset` 是它离节点上边的距离 —— 给到 TOOLBAR_OFFSET 就正好落在名字行上方，
      两块互不遮挡。别自己写 absolute，缩放平移时会歪。
    -->
    <NodeToolbar
      :is-visible="showToolbar"
      :position="Position.Top"
      align="center"
      :offset="TOOLBAR_OFFSET"
    >
      <div
        class="nodrag nopan flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
      >
        <!-- 复制的是节点 + 进入它的边，见 useFlowCanvas.duplicateNode -->
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full"
          title="复制节点（含进入它的连线）"
          @click.stop="canvas.duplicateNode(id)"
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          title="删除节点"
          @click.stop="canvas.deleteNode(id)"
        >
          <Trash2 />
        </Button>
      </div>
    </NodeToolbar>

    <Handle
      type="target"
      :position="Position.Left"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />

    <Handle
      type="source"
      :position="Position.Right"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />
  </div>
</template>
