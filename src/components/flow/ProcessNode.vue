<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { Handle, Position, type NodeProps } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { useFlowEditor } from "@/composables/flow"

export interface ProcessNodeData {
  label: string
}

const props = defineProps<NodeProps<ProcessNodeData>>()

const { presence, selection, store } = useFlowEditor()

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
  <div
    class="relative min-h-12 min-w-32 rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
  >
    <!--
      节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
      （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
      is-visible 常开，否则默认只在节点被选中时出现。
    -->
    <NodeToolbar :is-visible="true" :position="Position.Top" align="start" :offset="4">
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
