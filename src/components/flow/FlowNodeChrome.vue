<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { Position } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"
import { Copy, Trash2 } from "lucide-vue-next"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow"

/**
 * 节点的「外壳」：贴在节点外部左上角的名字（可双击改名）+ 选中时浮在上方的操作栏。
 *
 * 每种节点都要这两块，而且行为必须一模一样 —— 所以它们在这里只写一遍，
 * 各节点组件只管自己的**内容**（`ProcessNode` / `TextNode` / `GroupNode` …）。
 * 加一种节点因此不用连带抄一遍改名、复制、删除的逻辑。
 *
 * 按钮不一样的节点走 `#actions` 插槽换掉整排按钮（分组就没有「复制」），
 * 位置和露出时机仍旧由这里说了算 —— 那两件事在哪种节点上都该是一样的。
 */
const props = defineProps<{ nodeId: string; label: string }>()

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
 * 节点工具栏什么时候露出来：**当前单独选中的就是它，而且手上没在拉框**。
 *
 * 判 `selection` 而不是节点的 `selected`：前者是「现在轮到哪个节点」（Vue Flow 选中态的
 * 投影，只在恰好选中一个时有值），后者框选一片时每个都为真 —— 那会同时冒出一排工具栏，
 * 而上面的按钮都是对单个节点说的。框选一片时该出现的是**选区**工具栏
 * （`FlowSelectionToolbar`），那上面放的才是对一片节点说的动作。
 *
 * 拉框期间还要再挡一道：框扫过第一个节点时它会短暂地成为「唯一选中」，
 * 复制/删除于是闪一下又消失 —— 拉框时要看的是高亮，不是弹来弹去的按钮。
 */
const showToolbar = computed(
  () => selection.selectedNodeId.value === props.nodeId && !canvas.boxSelecting.value
)

/**
 * 谁正在动这个节点（远端）。
 *
 * **只是提示，不是限制** —— 谁都可以同时改同一个节点，CRDT 负责合并：
 * 改不同字段各自保留，改同一字段则收敛到同一个结果。
 */
const occupants = computed(() => presence.occupantsOf("node", props.nodeId))

// —— 就地改标题 ——

const editing = ref(false)
const draft = ref("")
const inputRef = ref<HTMLInputElement | null>(null)

/**
 * 双击标题就地改名。
 *
 * 先把选中态切到它身上：名字那一行是 teleport 出节点 DOM 的（NodeToolbar），
 * 点它不会冒泡成 `node-click`，所以得自己切；切了才会上报到 awareness，
 * 别人也就看得到「有人在动这个节点」。
 */
async function startEdit() {
  canvas.selectOnly(props.nodeId)
  draft.value = props.label
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
  if (!next || next === props.label) return

  // 改标题是一次独立的操作，别和刚才的拖动之类并进同一条撤销
  store.separateUndo()
  store.updateNodeData(props.nodeId, { label: next }, "修改节点标题")
  store.separateUndo()
}

function cancelEdit() {
  editing.value = false
}
</script>

<template>
  <!--
    节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
    （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
    is-visible 常开，否则默认只在节点被选中时出现。
  -->
  <NodeToolbar
    :node-id="nodeId"
    :is-visible="true"
    :position="Position.Top"
    align="start"
    :offset="LABEL_OFFSET"
  >
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
        {{ label }}
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
    :node-id="nodeId"
    :is-visible="showToolbar"
    :position="Position.Top"
    align="center"
    :offset="TOOLBAR_OFFSET"
  >
    <div
      class="nodrag nopan flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
    >
      <!-- 默认这一排：复制 + 删除。按钮不一样的节点（分组）用这个插槽换掉 -->
      <slot name="actions">
        <!-- 复制的是节点 + 进入它的边，见 useFlowCanvas.duplicateNode -->
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full"
          title="复制节点（含进入它的连线）"
          @click.stop="canvas.duplicateNode(nodeId)"
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          title="删除节点"
          @click.stop="canvas.deleteNode(nodeId)"
        >
          <Trash2 />
        </Button>
      </slot>
    </div>
  </NodeToolbar>
</template>
